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
 * acceptance and TTFT, and `undici:request:bodyChunkReceived` carries the
 * response bytes as they arrive on the wire.
 *
 * Everything here is a pure state machine over injected clocks: no Cordis, no
 * diagnostics, no globals, so the arithmetic is directly unit-testable.
 *
 * @module dsh-plugin-model-request-accelerator/timing
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
			cacheReadTokens: null,
			cacheWriteTokens: null,
			requestBytes: null,
			sentBytes: null,
			responseBytes: 0,
			responseChunks: 0,
			responseEncoding: null,
			compressed: false,
			encoding: null,
			prewarm: null,
			prewarmMiss: null,
			attempts: 0,
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
	 * @param requestBytes - size of the serialized JSON body.
	 * @returns true when this call started the measured request.
	 */
	const noteFetch = (record, url, requestBytes) => {
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
		record.requestBytes = Number.isFinite(requestBytes) ? requestBytes : null;
		record.sentBytes = record.requestBytes;
		return true;
	};

	/**
	 * Whether one undici request is the request this record is measuring.
	 *
	 * The transport diagnostics are process-wide and — on a pooled keep-alive
	 * connection — can even fire inside an *earlier* request's async context, so
	 * the caller pairs this check with the request object's own identity instead
	 * of trusting the ambient context.
	 *
	 * @param record - the open measurement.
	 * @param request - the undici request the diagnostic carries.
	 * @returns true when origin and pathname match what `noteFetch` recorded.
	 */
	const claimsRequest = (record, request) => {
		if (record.pendingOrigin === null || request === null || typeof request !== "object") return false;
		return request.origin === record.pendingOrigin && pathnameOf(request.path) === record.pendingPath;
	};

	/**
	 * Record the size actually written to the socket. Called only when the body
	 * was rewritten, so `compressed` reflects a real reduction.
	 */
	const noteSent = (record, sentBytes, encoding) => {
		if (encoding !== undefined && encoding !== null) record.encoding = encoding;
		if (!Number.isFinite(sentBytes)) return;
		record.sentBytes = sentBytes;
		record.compressed = record.requestBytes !== null && sentBytes < record.requestBytes;
	};

	/**
	 * Record that this request was served from a held, pre-transmitted one.
	 * @param record - the measurement.
	 * @param info - how much was pre-sent, how much was still written, and how
	 *   long the request was held open.
	 */
	const notePrewarm = (record, info) => {
		record.prewarm = info;
	};

	/**
	 * Record that pre-transmission was available but did not serve this request,
	 * and why — an unexplained miss is indistinguishable from the feature being
	 * off, which is exactly the kind of thing worth seeing.
	 */
	const notePrewarmMiss = (record, reason) => {
		record.prewarmMiss = reason;
	};

	/**
	 * Apply one transport phase.
	 * @param record - the measurement the diagnostic was attributed to.
	 * @param phase - `body-sent` (upload finished) or `headers` (server answered).
	 * @param atMs - monotonic timestamp.
	 * @returns true when the phase was consumed.
	 */
	const notePhase = (record, phase, atMs) => {
		if (phase === "body-sent") {
			if (record.bodySentMs !== null) return false;
			record.bodySentMs = atMs;
			return true;
		}
		if (phase === "headers") {
			if (record.headersMs !== null) return false;
			record.headersMs = atMs;
			return true;
		}
		return false;
	};

	/**
	 * Add one received response chunk. These are wire bytes, so a gzip-encoded
	 * reply counts as what actually crossed the network.
	 * @param record - the measurement the chunk belongs to.
	 * @param bytes - the chunk's byte length.
	 */
	const noteResponseBytes = (record, bytes) => {
		if (!Number.isFinite(bytes)) return;
		record.responseChunks += 1;
		record.responseBytes += bytes;
	};

	/**
	 * Remember how the response body was encoded on the wire, so a gzip-encoded
	 * reply is reported as such rather than merely looking small.
	 * @param record - the measurement the headers belong to.
	 * @param encoding - the response's `content-encoding`, when it declared one.
	 */
	const noteResponseEncoding = (record, encoding) => {
		if (typeof encoding !== "string") return;
		const trimmed = encoding.trim();
		if (trimmed.length > 0) record.responseEncoding = trimmed;
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
			// The provider's prefix-cache accounting: how much of this prompt it
			// recognised as already computed. This is the measured effect of keeping
			// a conversation's prefix stable, and the number worth optimising.
			if (Number.isFinite(chunk.usage.cacheReadTokens)) record.cacheReadTokens = (record.cacheReadTokens ?? 0) + chunk.usage.cacheReadTokens;
			if (Number.isFinite(chunk.usage.cacheWriteTokens)) record.cacheWriteTokens = (record.cacheWriteTokens ?? 0) + chunk.usage.cacheWriteTokens;
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
			// From the request being issued to the first token — for a pre-transmitted
			// request, that is from the member being claimed. This is the wait a user
			// actually experiences, which the separate phases do not show at a glance.
			toFirstTokenMs: started !== null && first !== null ? round(first - started) : null,
			totalMs: started !== null && done !== null ? round(done - started) : null,
			inputTokens: record.inputTokens,
			outputTokens,
			cacheReadTokens: record.cacheReadTokens,
			cacheWriteTokens: record.cacheWriteTokens,
			// `inputTokens` counts UNCACHED input only, so the prompt is the two
			// together; dividing by inputTokens alone would overstate the rate.
			cacheHitPercent: record.cacheReadTokens !== null && record.inputTokens !== null && record.cacheReadTokens + record.inputTokens > 0
				? round((record.cacheReadTokens / (record.cacheReadTokens + record.inputTokens)) * 100)
				: null,
			tokensPerSecond: outputTokens !== null && outputTokens !== undefined && generationMs !== null && generationMs > 0 ? round(outputTokens / (generationMs / 1000)) : null,
			requestBytes: record.requestBytes,
			sentBytes: record.sentBytes,
			// `null` when no chunk was ever attributed — which is a wiring fault to
			// see, not the same thing as a genuinely empty response.
			responseBytes: record.responseChunks > 0 ? record.responseBytes : null,
			responseEncoding: record.responseEncoding,
			compressed: record.compressed,
			encoding: record.encoding,
			prewarm: record.prewarm,
			prewarmMiss: record.prewarmMiss,
			attempts: record.attempts
		};
	};

	/**
	 * Detached measurements for one session, oldest first.
	 * @param sessionId - the session to read, or `null` for records with no session.
	 * @returns the projection the browser renders.
	 */
	/**
	 * Rows restored from durable storage, per session. They sit ahead of the live
	 * records so a restarted process shows a session's history instead of an
	 * empty panel, and a session already being measured is never displaced by a
	 * late load.
	 */
	const restored = new Map();

	/**
	 * Seed one session from stored rows, once.
	 * @param sessionId - the session key.
	 * @param rows - rows read back from storage.
	 * @returns whether anything was seeded.
	 */
	const seed = (sessionId, rows) => {
		const key = sessionId ?? "";
		if (sessions.has(key) || restored.has(key)) return false;
		if (!Array.isArray(rows) || rows.length === 0) return false;
		restored.set(key, rows.slice(-MAX_PER_SESSION));
		while (restored.size > MAX_SESSIONS) restored.delete(restored.keys().next().value);
		return true;
	};

	/** Whether anything at all is known about one session. */
	const has = (sessionId) => restored.has(sessionId ?? "") || sessions.has(sessionId ?? "");

	/** Stored rows first, then live ones, bounded as one history per session. */
	const rowsFor = (sessionId) => {
		const key = sessionId ?? "";
		return [...(restored.get(key) ?? []), ...(sessions.get(key) ?? []).map(summarize)].slice(-MAX_PER_SESSION);
	};

	/**
	 * Everything known about one session, newest last — the shape persisted and
	 * the shape the panel renders, so a restored session looks exactly like a
	 * live one.
	 * @param sessionId - the session key.
	 * @returns the row list.
	 */
	const snapshot = (sessionId) => rowsFor(sessionId);

	return { begin, seed, has, noteFetch, noteSent, claimsRequest, notePhase, noteResponseBytes, noteResponseEncoding, notePrewarm, notePrewarmMiss, observeChunk, finish, summarize, snapshot };
}
