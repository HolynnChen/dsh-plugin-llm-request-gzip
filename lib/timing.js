/**
 * Model-request timing decomposition.
 *
 * Splits one model call into the phases a client can actually act on, using
 * two independent measurement sources:
 *
 *   stream begin ──▶ fetch() ──────▶ body sent ──────▶ first token ──────▶ end
 *        │             │                │                  │              │
 *        │        prepareMs         sendMs            ttftMs        generationMs
 *        │                            └──────── serverMs ─┘
 *        └──────────────────────────── totalMs ────────────────────────────┘
 *
 * `sendMs` — the user-visible "how long did the request take to send" — comes
 * from undici's own `undici:request:bodySent` diagnostic, so it is the moment
 * the transport finished writing the body, not a proxy for it. Response
 * headers (`undici:request:headers`) split the waiting time into server
 * acceptance and TTFT.
 *
 * Everything here is a pure state machine over injected clocks: no Cordis, no
 * diagnostics, no globals, so the arithmetic is directly unit-testable.
 *
 * @module dsh-plugin-llm-request-gzip/timing
 */

/** Most recent measurements retained per session. */
export const MAX_PER_SESSION = 100;

/** Most recent sessions retained before the oldest is evicted. */
export const MAX_SESSIONS = 40;

/**
 * Whether a chunk carries the first visible model output — the same rule the
 * shipped Trajectory view uses for its own TTFT, so both agree on the moment.
 * @param chunk - one `StreamChunk` from the adapter.
 * @returns true for a non-empty text, reasoning, or tool-call delta.
 */
export function isTokenDelta(chunk) {
	switch (chunk?.type) {
		case "text-delta":
		case "reasoning-delta":
			return chunk.text !== "";
		case "tool-call-delta":
			return chunk.argumentsDelta !== "" || chunk.name !== undefined;
		default:
			return false;
	}
}

/** Strip a query string so a fetch URL and an undici request path compare equal. */
export function pathnameOf(target) {
	const text = String(target ?? "");
	const cut = text.indexOf("?");
	return cut === -1 ? text : text.slice(0, cut);
}

/** Round to one decimal so wire payloads stay small and stable. */
function round(value) {
	return Math.round(value * 10) / 10;
}

/**
 * Owns the measurement ring buffer and the phase arithmetic.
 *
 * Clocks are injected: `now()` must be monotonic (durations), `wallNow()` is
 * the wall clock used only for display.
 */
export function createTimingStore(options) {
	const now = options.now;
	const wallNow = options.wallNow;
	/** sessionId -> measurements, oldest first. Insertion order doubles as the LRU order. */
	const sessions = new Map();
	let nextId = 1;

	/** Keep the session map bounded so a long-running process cannot grow without limit. */
	const touch = (sessionId, list) => {
		sessions.delete(sessionId);
		sessions.set(sessionId, list);
		while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
	};

	/**
	 * Open one measurement for a streaming model call.
	 * @param call - provider, model, optional session id and purpose.
	 * @returns the mutable record, already visible to snapshots as `running`.
	 */
	const begin = (call) => {
		const record = {
			id: nextId++,
			sessionId: call.sessionId ?? null,
			provider: call.provider ?? null,
			model: call.model ?? null,
			purpose: call.purpose ?? null,
			beginMs: now(),
			startedAt: wallNow(),
			startedAtMs: null,
			bodySentMs: null,
			headersMs: null,
			firstTokenMs: null,
			completedMs: null,
			inputTokens: null,
			outputTokens: null,
			attempts: 0,
			compressed: null,
			pendingOrigin: null,
			pendingPath: null,
			status: "running"
		};
		const key = record.sessionId ?? "";
		const list = sessions.get(key) ?? [];
		list.push(record);
		while (list.length > MAX_PER_SESSION) list.shift();
		touch(key, list);
		return record;
	};

	/**
	 * Attribute one `fetch` call to a record. Only a string-bodied request made
	 * inside the stream's own async scope is the model request: the Files API
	 * upload that may precede it carries a `FormData` body and is ignored.
	 * @param record - the open measurement.
	 * @param url - the absolute request URL.
	 * @returns true when this call started the measured request.
	 */
	const noteFetch = (record, url) => {
		record.attempts += 1;
		if (record.startedAtMs !== null) return false;
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			return false;
		}
		record.startedAtMs = now();
		record.startedAt = wallNow();
		record.pendingOrigin = parsed.origin;
		record.pendingPath = parsed.pathname;
		return true;
	};

	/**
	 * Whether a transport diagnostic belongs to the measured request. Guards
	 * against a shared keep-alive connection delivering another request's
	 * events, or a genuine retry inside the same stream.
	 */
	const owns = (record, request) => {
		if (record.pendingOrigin === null) return false;
		return request?.origin === record.pendingOrigin && pathnameOf(request?.path) === record.pendingPath;
	};

	/**
	 * Apply one undici transport diagnostic.
	 * @param record - the open measurement.
	 * @param kind - `body-sent` (upload finished) or `headers` (server answered).
	 * @param request - the undici request the diagnostic carries.
	 * @param atMs - monotonic timestamp.
	 * @returns true when the diagnostic was consumed.
	 */
	const noteTransport = (record, kind, request, atMs) => {
		if (!owns(record, request)) return false;
		if (kind === "body-sent") {
			if (record.bodySentMs !== null) return false;
			record.bodySentMs = atMs;
			return true;
		}
		if (kind === "headers") {
			if (record.headersMs !== null) return false;
			record.headersMs = atMs;
			return true;
		}
		return false;
	};

	/**
	 * Fold one stream chunk: the first token and the usage totals.
	 * @param record - the open measurement.
	 * @param chunk - one `StreamChunk`.
	 * @param atMs - monotonic timestamp.
	 */
	const observeChunk = (record, chunk, atMs) => {
		if (record.firstTokenMs === null && isTokenDelta(chunk)) record.firstTokenMs = atMs;
		if (chunk?.type === "usage" && chunk.usage !== null && typeof chunk.usage === "object") {
			if (Number.isFinite(chunk.usage.outputTokens)) record.outputTokens = (record.outputTokens ?? 0) + chunk.usage.outputTokens;
			if (Number.isFinite(chunk.usage.inputTokens)) record.inputTokens = (record.inputTokens ?? 0) + chunk.usage.inputTokens;
		}
	};

	/**
	 * Close one measurement. A stream that ends without a token (an error, or a
	 * refusal) still closes: the phases that did happen remain reportable.
	 * @param record - the open measurement.
	 * @param atMs - monotonic timestamp.
	 * @param outcome - `complete` or `error`.
	 */
	const finish = (record, atMs, outcome = "complete") => {
		if (record.completedMs !== null) return;
		record.completedMs = atMs;
		record.status = outcome;
	};

	/**
	 * Project one record into the detached, JSON-safe shape the browser reads.
	 * Absent phases stay `null` rather than becoming a misleading zero.
	 */
	const summarize = (record) => {
		const started = record.startedAtMs;
		const sent = record.bodySentMs;
		const headers = record.headersMs;
		const first = record.firstTokenMs;
		const done = record.completedMs;
		const generationMs = first !== null && done !== null ? done - first : null;
		const outputTokens = record.outputTokens;
		return {
			id: record.id,
			sessionId: record.sessionId,
			provider: record.provider,
			model: record.model,
			purpose: record.purpose,
			status: record.status,
			startedAt: record.startedAt,
			prepareMs: started !== null ? round(started - record.beginMs) : null,
			sendMs: started !== null && sent !== null ? round(sent - started) : null,
			serverMs: sent !== null && headers !== null ? round(headers - sent) : null,
			ttftMs: sent !== null && first !== null ? round(first - sent) : null,
			generationMs: generationMs === null ? null : round(generationMs),
			totalMs: started !== null && done !== null ? round(done - started) : null,
			inputTokens: record.inputTokens,
			outputTokens,
			tokensPerSecond: outputTokens !== null && outputTokens !== undefined && generationMs !== null && generationMs > 0 ? round(outputTokens / (generationMs / 1000)) : null,
			attempts: record.attempts,
			compressed: record.compressed
		};
	};

	/**
	 * Detached measurements for one session, oldest first.
	 * @param sessionId - the session to read, or `null` for records with no session.
	 * @returns the projection the browser renders.
	 */
	const snapshot = (sessionId) => {
		const list = sessions.get(sessionId ?? "") ?? [];
		return list.map(summarize);
	};

	return { begin, noteFetch, noteTransport, observeChunk, finish, summarize, snapshot };
}
