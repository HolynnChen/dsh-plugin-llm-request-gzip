/**
 * Pre-transmission support: finding the bytes a follow-up request is expected
 * to repeat.
 *
 * A multi-turn conversation re-sends its whole history every step. The bytes up
 * to the end of the last message are therefore identical between step N and
 * step N+1, and only the assistant turn plus the tool results are new. This
 * module locates that boundary inside a serialized request body so the shared
 * part can be put on the wire early — while tools are still running — leaving
 * only the increment to be written when the next request is actually issued.
 *
 * Pure string handling: no Cordis, no zlib, no globals.
 *
 * @module dsh-plugin-llm-request-gzip/prewarm
 */

/** The key every OpenAI-compatible body carries its history under. */
const MESSAGES_KEY = '"messages"';

/**
 * Find the offset just past the last element of the top-level `messages` array.
 *
 * The scan is string- and escape-aware, and depth-aware, so a nested array or a
 * brace inside a message's text cannot end the prefix early. Scalars are not
 * treated as elements, which is safe: a body whose last message is not an
 * object simply yields the previous object's end, and the caller verifies the
 * prefix against the real body before using it.
 *
 * @param json - the serialized request body.
 * @returns the exclusive end offset of the last message, or `undefined` when
 *   the body carries no usable history.
 */
export function messagesPrefixEnd(json) {
	if (typeof json !== "string") return undefined;
	const key = json.indexOf(MESSAGES_KEY);
	if (key === -1) return undefined;
	const skipSpace = (from) => {
		let at = from;
		while (at < json.length && (json[at] === " " || json[at] === "\n" || json[at] === "\t" || json[at] === "\r")) at += 1;
		return at;
	};
	let index = skipSpace(key + MESSAGES_KEY.length);
	if (json[index] !== ":") return undefined;
	index = skipSpace(index + 1);
	if (json[index] !== "[") return undefined;
	index += 1;

	let depth = 0;
	let inString = false;
	let escaped = false;
	let lastEnd = -1;
	for (; index < json.length; index += 1) {
		const ch = json[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') {
				inString = false;
				if (depth === 0) lastEnd = index + 1;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" || ch === "[") {
			depth += 1;
			continue;
		}
		if (ch === "}") {
			depth -= 1;
			if (depth === 0) lastEnd = index + 1;
			continue;
		}
		if (ch === "]") {
			if (depth === 0) break;
			depth -= 1;
			if (depth === 0) lastEnd = index + 1;
		}
	}
	return lastEnd === -1 ? undefined : lastEnd;
}

/**
 * The bytes a follow-up request is expected to repeat, or `undefined` when this
 * body offers no shared prefix to pre-send.
 * @param json - the serialized request body of the request that just finished.
 * @returns the prefix text.
 */
export function prewarmPrefix(json) {
	const end = messagesPrefixEnd(json);
	if (end === undefined || end === 0) return undefined;
	return json.slice(0, end);
}

/**
 * Whether two header sets are the same for pre-transmission purposes. A
 * pre-opened request carries the previous request's headers, so a follow-up
 * that differs anywhere — a compaction marker, a changed session id, a new
 * credential — must not be served from it.
 * @param prewarmed - the headers the pre-opened request was opened with.
 * @param incoming - the headers of the request that actually arrived.
 * @returns true when every incoming header matches, case-insensitively.
 */
export function headersMatch(prewarmed, incoming) {
	const normalize = (headers) => {
		const pairs = [];
		if (headers === undefined || headers === null) return pairs;
		if (typeof headers.forEach === "function" && typeof headers.get === "function") headers.forEach((value, key) => pairs.push([String(key).toLowerCase(), String(value)]));
		else if (Array.isArray(headers)) for (const pair of headers) pairs.push([String(pair[0]).toLowerCase(), String(pair[1])]);
		else if (typeof headers === "object") for (const key of Object.keys(headers)) pairs.push([key.toLowerCase(), String(headers[key])]);
		return pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
	};
	const left = normalize(prewarmed);
	const right = normalize(incoming);
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index][0] !== right[index][0] || left[index][1] !== right[index][1]) return false;
	}
	return true;
}

/**
 * Whether a pre-transmission attempt should be retried as an ordinary request.
 *
 * These are the statuses a gateway uses to refuse the *shape* of the request
 * rather than its content — a body sent with `Transfer-Encoding: chunked` is
 * what pre-transmission produces. Anything else is a real provider answer and
 * is handed back untouched, so retry policy and error reporting stay the
 * adapter's business.
 * @param status - the pre-opened request's response status.
 * @returns true when the same body should be sent again as a normal request.
 */
export function isShapeRejection(status) {
	return status === 411 || status === 415 || status === 501;
}

/** Keys an assistant message may carry for the fill to be predictable at all. */
const ASSISTANT_KEYS = ["role", "content", "tool_calls"];
/** Keys one tool call may carry for the fill to be predictable. */
const CALL_KEYS = ["id", "type", "function"];
/** Keys the nested `function` object may carry. */
const FUNCTION_KEYS = ["name", "arguments"];

/** Whether every key of `value` is in `allowed` (and it has at least one). */
function onlyKeys(value, allowed) {
	if (value === null || typeof value !== "object") return false;
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((key) => allowed.includes(key));
}

/**
 * Predict the bytes an assistant turn will add to the conversation.
 *
 * The next request is built by the adapter, so the only way to put that turn on
 * the wire early is to reproduce its serialization. This does so with two
 * guardrails rather than by guessing: the captured body must round-trip through
 * `JSON.parse`/`JSON.stringify` unchanged (which proves the adapter emits plain
 * JSON in one key order), and the previous assistant turn must use only the
 * fields this can reason about — any unknown field declines rather than
 * guessing. A wrong prediction is harmless: it is caught byte for byte when the
 * next request claims a member.
 *
 * @param body - the captured body of the request that just finished.
 * @param assistant - the turn that finished: its text and its tool calls.
 * @returns the bytes to append, or `undefined` when the fill cannot be trusted.
 */
export function predictAssistantIncrement(body, assistant) {
	if (typeof body !== "string" || assistant === null || typeof assistant !== "object") return undefined;
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	// The self-test: if the adapter's bytes are not plain `JSON.stringify` output
	// in the parsed key order, nothing below can be predicted reliably.
	if (JSON.stringify(parsed) !== body) return undefined;
	const messages = parsed.messages;
	if (!Array.isArray(messages) || messages.length === 0) return undefined;
	const template = [...messages].reverse().find((message) => message !== null && typeof message === "object" && message.role === "assistant");
	if (template === undefined || !onlyKeys(template, ASSISTANT_KEYS)) return undefined;

	const calls = Array.isArray(assistant.toolCalls) ? assistant.toolCalls : [];
	const callTemplate = Array.isArray(template.tool_calls) && template.tool_calls.length > 0 ? template.tool_calls[0] : undefined;
	// The turn that is being predicted and the turn used as a template must have
	// the SAME shape: whether `tool_calls` is present decides how the adapter
	// frames the message, and a mismatch means the framing is unknown.
	if ((calls.length > 0) !== (callTemplate !== undefined)) return undefined;
	if (callTemplate !== undefined && !onlyKeys(callTemplate, CALL_KEYS)) return undefined;
	if (callTemplate !== undefined && !onlyKeys(callTemplate.function, FUNCTION_KEYS)) return undefined;

	// Rebuild the turn in the template's own key order.
	const next = {};
	for (const key of Object.keys(template)) {
		if (key === "role") next.role = "assistant";
		else if (key === "content") {
			// Mirror the template's own convention for an empty turn: some adapters
			// send `null`, some send `""`.
			const text = typeof assistant.text === "string" ? assistant.text : "";
			next.content = template.content === null && text === "" ? null : text;
		}
		else if (key === "tool_calls") {
			next.tool_calls = calls.map((call) => {
				const entry = {};
				for (const callKey of Object.keys(callTemplate)) {
					if (callKey === "id") entry.id = call.id;
					else if (callKey === "type") entry.type = callTemplate.type;
					else if (callKey === "function") {
						const fn = {};
						for (const fnKey of Object.keys(callTemplate.function)) {
							if (fnKey === "name") fn.name = call.name ?? "";
							else if (fnKey === "arguments") fn.arguments = call.arguments ?? "";
							else fn[fnKey] = callTemplate.function[fnKey];
						}
						entry.function = fn;
					} else entry[callKey] = callTemplate[callKey];
				}
				return entry;
			});
		}
	}

	const nextBody = JSON.stringify({ ...parsed, messages: [...messages, next] });
	const currentEnd = messagesPrefixEnd(body);
	const nextEnd = messagesPrefixEnd(nextBody);
	if (currentEnd === undefined || nextEnd === undefined) return undefined;
	if (!nextBody.startsWith(body.slice(0, currentEnd))) return undefined;
	return { from: body.slice(0, currentEnd), appended: nextBody.slice(currentEnd, nextEnd), prefix: nextBody.slice(0, nextEnd) };
}
