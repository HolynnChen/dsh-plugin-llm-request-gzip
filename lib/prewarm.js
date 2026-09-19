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
 * @module dsh-plugin-model-request-accelerator/prewarm
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

/**
 * Move `messages` to the end of the body, leaving every other field in the order
 * the adapter chose.
 *
 * The pre-sent prefix is the *beginning* of the body, so any field that sits
 * after `messages` — the tool schemas above all, then the stream flag, the tool
 * choice and the rest — can never be part of it and is uploaded again on every
 * single request. JSON objects are unordered, so moving one key changes no
 * meaning, only how much of the body can be put on the wire early. It does not
 * make the request any smaller: it moves bytes off the critical path, it does not
 * remove them.
 *
 * The transformation is deliberately minimal and refused whenever it cannot be
 * proven byte-safe: the body must be exactly what `JSON.stringify` produces, so
 * that re-serializing it leaves every field's own bytes alone, and only one key
 * moves.
 *
 * @param body - the serialized request body.
 * @returns the reordered body, or `undefined` to leave it exactly as it is.
 */
export function moveMessagesLast(body) {
	if (typeof body !== "string") return undefined;
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	if (!Object.hasOwn(parsed, "messages")) return undefined;
	// Only plain `JSON.stringify` output can be reordered without touching any
	// field's bytes; anything else is left alone.
	if (JSON.stringify(parsed) !== body) return undefined;
	const keys = Object.keys(parsed);
	if (keys[keys.length - 1] === "messages") return undefined;
	if (keys.length < 2) return undefined;
	const reordered = {};
	for (const key of keys) if (key !== "messages") reordered[key] = parsed[key];
	reordered.messages = parsed.messages;
	const next = JSON.stringify(reordered);
	return next === body ? undefined : next;
}
