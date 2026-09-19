/**
 * Per-provider gzip compression for model requests.
 *
 * Response compression is already on in Node: undici's `fetch` sends
 * `accept-encoding: gzip, deflate` by default and decompresses the reply, so
 * there is nothing to enable on that side. The switch that actually moves
 * bytes is the **request** direction: a chat-completions body carrying a long
 * context (and possibly base64 images) is compressed with gzip and announced
 * with `content-encoding: gzip`, which typically removes 90%+ of the upload.
 *
 * The adapter seam offers no header hook — both shipped adapters call the
 * global `fetch` directly — so this plugin owns that seam: it patches
 * `globalThis.fetch` for the lifetime of its fiber and rewrites only requests
 * it can attribute to an enabled provider.
 *
 * Attribution comes from the `llm/stream` waterfall, wrapped in an
 * `AsyncLocalStorage` scope so the provider identity survives the adapter's
 * internal `await`s and cannot be confused by concurrent streams. When a
 * request arrives with no attribution (a hand-built call), the endpoint index
 * is used as a fallback.
 *
 * @module dsh-plugin-llm-request-gzip
 */

import { AsyncLocalStorage } from "node:async_hooks";
import diagnosticsChannel from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { constants as zlibConstants, createGzip, gzipSync } from "node:zlib";
import z from "@deepseek-ai/schemastery";
import {
	compilePolicies,
	DEFAULT_MIN_BYTES,
	indexEndpoints,
	planGzip,
	readEndpoint,
	readHeader,
	resolvePolicy,
	withGzipHeader
} from "./compress.js";
import { headersMatch, isShapeRejection, prewarmPrefix } from "./prewarm.js";
import { createTimingStore } from "./timing.js";

/** Host plugin name; also the settings namespace this plugin owns. */
export const name = "llm-request-gzip";

/** Settings namespace key. Must be a lowercase hyphenated identifier. */
export const NS = name;

/** Header this plugin adds; its presence means the request is already compressed. */
const CONTENT_ENCODING = "content-encoding";

/** Composition base: everything off until the user opts a provider in. */
const BASE = { providers: {} };

/** How long a pre-opened request is held open by default. */
const DEFAULT_PREWARM_HOLD_MS = 120000;

/**
 * How many conversations may hold a pre-opened request at once. There is only
 * ever one possible successor per conversation, so this is a resource bound on
 * concurrent held requests — not a set of alternatives to choose from.
 */
const DEFAULT_PREWARM_POOL_SIZE = 3;

/**
 * Statuses that mean a gateway refused the request's *shape* — pre-transmission
 * produces a chunked body, which some proxies reject. These are resent as an
 * ordinary request; any other answer is the provider's real reply.
 */

/** Authenticated browser route serving the timing ledger. */
const TIMINGS_PATH = "/api/llm-request-gzip/timings";

/** The undici diagnostic that identifies one request, emitted before any socket I/O. */
const REQUEST_CREATED_CHANNEL = "undici:request:create";

/** undici transport diagnostics consumed per measurement, as `channel -> sink`. */
const TRANSPORT_CHANNELS = [
	["undici:request:bodySent", "phase:body-sent"],
	["undici:request:headers", "phase:headers"],
	["undici:request:bodyChunkReceived", "response-bytes"]
];

/**
 * Durable settings section. Routes are dynamic (they mirror the deployment's
 * configurable providers), so the per-route policy is a dict rather than a
 * fixed field list.
 */
export const Config = z.object({
	providers: z.dict(z.object({
		enabled: z.boolean().default(false).description("Send this provider's model requests gzip-compressed."),
		minBytes: z.number().step(1).min(0).default(DEFAULT_MIN_BYTES).description("Skip compression below this request-body size, in bytes."),
		prewarm: z.boolean().default(false).description("Open the next request early and send its shared history while tools still run, leaving only the increment for the real request.")
	})).default({}).description("Per-provider request-body policy."),
	prewarmHoldMs: z.number().step(1).min(1000).default(DEFAULT_PREWARM_HOLD_MS).description("How long a pre-opened request may be held before it is abandoned."),
	prewarmPoolSize: z.number().step(1).min(1).default(DEFAULT_PREWARM_POOL_SIZE).description("How many conversations may hold a pre-opened request at once."),
	timing: z.boolean().default(true).description("Record request timings and offer the Request timing view beside the Trajectory.")
});

/**
 * Read one header out of an undici diagnostics payload. `response.headers` is a
 * flat list of alternating Buffer names and values, not a map, so it has to be
 * walked rather than indexed.
 * @param headers - the diagnostic's `response.headers`.
 * @param name - lower-cased header name to find.
 * @returns the decoded value, or `undefined` when the header is absent.
 */
function diagnosticHeader(headers, name) {
	if (!Array.isArray(headers)) return undefined;
	for (let index = 0; index + 1 < headers.length; index += 2) {
		const key = headers[index];
		const text = Buffer.isBuffer(key) ? key.toString("latin1") : String(key);
		if (text.toLowerCase() !== name) continue;
		const value = headers[index + 1];
		return Buffer.isBuffer(value) ? value.toString("latin1") : String(value);
	}
	return undefined;
}

/**
 * Register the settings section, attribute streaming calls to their provider,
 * and patch the global `fetch` for the lifetime of this plugin's fiber.
 * @param ctx - Host context.
 */
export function apply(ctx) {
	const attribution = new AsyncLocalStorage();
	const state = { policies: new Map(), byEndpoint: new Map(), timing: true, prewarmHoldMs: DEFAULT_PREWARM_HOLD_MS, prewarmPoolSize: DEFAULT_PREWARM_POOL_SIZE };
	let source = () => BASE;

	/**
	 * Recompile the stored policy and the `endpoint -> routes` index. Provider
	 * endpoints live in *other* plugins' settings namespaces, so this runs again
	 * whenever any namespace changes or the adapter directory moves.
	 */
	const refresh = () => {
		const section = source();
		state.policies = compilePolicies(section);
		state.timing = section?.timing !== false;
		state.prewarmHoldMs = Number.isFinite(section?.prewarmHoldMs) && section.prewarmHoldMs >= 1000 ? section.prewarmHoldMs : DEFAULT_PREWARM_HOLD_MS;
		state.prewarmPoolSize = Number.isFinite(section?.prewarmPoolSize) && section.prewarmPoolSize >= 1 ? Math.floor(section.prewarmPoolSize) : DEFAULT_PREWARM_POOL_SIZE;
		const directory = ctx.get("llm")?.listConfigurableProviders?.() ?? [];
		const settings = ctx.get("settings");
		const endpoints = new Map();
		for (const entry of directory) {
			let value;
			try {
				value = settings?.get(entry.settingsNs);
			} catch {
				value = undefined;
			}
			endpoints.set(entry.provider, readEndpoint(value, entry.settingsPath));
		}
		state.byEndpoint = indexEndpoints(endpoints);
	};

	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, NS, Config, BASE, {
			setSource: (next) => {
				source = next;
				refresh();
			},
			onChange: () => {
				refresh();
			}
		});
	});
	ctx.on("settings/updated", () => {
		refresh();
	});
	ctx.on("llm/adapters-updated", () => {
		refresh();
	});
	refresh();

	/** Monotonic clock for phase durations; the wall clock is for display only. */
	const timing = createTimingStore({ now: () => performance.now(), wallNow: () => Date.now() });

	//#region pre-transmission

	/** At most one held request per session/provider/model. */
	const prewarms = new Map();

	/**
	 * Endpoints that answered a pre-transmitted request badly. A refusal there is
	 * far more likely to be about the chunked body than about the request, so the
	 * endpoint is never pre-warmed again for the life of the process.
	 */
	const prewarmBlocked = new Set();

	/** The key a pre-opened request is filed under, or `undefined` to skip it. */
	const prewarmKey = (scope) => {
		if (scope.prewarm !== true || scope.provider === undefined) return undefined;
		// Compaction and title requests carry a different history, and a different
		// body shape; they neither open nor consume a pre-opened request.
		if (scope.purpose !== null && scope.purpose !== undefined) return undefined;
		return `${scope.sessionId ?? ""}\u0000${scope.provider}\u0000${scope.model ?? ""}`;
	};

	/** A plain header copy, so two header sets can be compared and reused. */
	const plainHeaders = (headers) => {
		const out = {};
		if (headers === undefined || headers === null) return out;
		if (typeof headers.forEach === "function" && typeof headers.get === "function") headers.forEach((value, key) => { out[key] = value; });
		else if (Array.isArray(headers)) for (const pair of headers) out[String(pair[0])] = pair[1];
		else if (typeof headers === "object") for (const key of Object.keys(headers)) out[key] = headers[key];
		return out;
	};

	/**
	 * Encode one body in two parts whose concatenation is a single valid stream:
	 * a second gzip member or a second JSON chunk would either break decompression
	 * or double the framing, so the gzip case keeps ONE deflate stream open across
	 * the split and flushes it between the parts.
	 */
	const createWireEncoder = (gzipEnabled) => {
		if (gzipEnabled !== true) {
			const encoder = new TextEncoder();
			return {
				async prefix(text) {
					return encoder.encode(text);
				},
				async finish(text) {
					return encoder.encode(text);
				},
				dispose() {}
			};
		}
		const stream = createGzip();
		const chunks = [];
		let drained = 0;
		stream.on("data", (chunk) => chunks.push(chunk));
		const take = () => {
			const next = Buffer.concat(chunks).subarray(drained);
			drained += next.length;
			return next;
		};
		return {
			async prefix(text) {
				await new Promise((resolve) => {
					stream.write(Buffer.from(text));
					stream.flush(zlibConstants.Z_SYNC_FLUSH, resolve);
				});
				return take();
			},
			async finish(text) {
				// `end(chunk, callback)` reports the write, not the drain: waiting on
				// it would hand back a truncated body with no gzip footer.
				await new Promise((resolve, reject) => {
					stream.once("end", resolve);
					stream.once("error", reject);
					stream.end(Buffer.from(text));
				});
				return take();
			},
			dispose() {
				try {
					stream.destroy();
				} catch {}
			}
		};
	};

	/**
	 * Abandon the held request for one conversation, if it has one. Called when a
	 * step turns out to end the turn: with no tool calls there is no next request
	 * to pre-serve, so holding one would only occupy a gateway slot until the hold
	 * timeout expired.
	 */
	const dropPrewarmFor = (scope) => {
		const key = prewarmKey(scope);
		if (key === undefined) return;
		const entry = prewarms.get(key);
		if (entry !== undefined) dropPrewarm(entry);
	};

	/** Abandon one held request: stop its timer, fail its body, close its socket. */
	const dropPrewarm = (entry) => {
		if (entry.dropped === true) return;
		entry.dropped = true;
		clearTimeout(entry.timer);
		prewarms.delete(entry.key);
		try {
			entry.encoder.dispose();
		} catch {}
		try {
			entry.stream.error(new Error("pre-transmission abandoned"));
		} catch {}
		try {
			entry.abort.abort();
		} catch {}
	};

	/**
	 * Put the shared history of the next request on the wire now, while the tools
	 * the last step asked for are still running. Only the bytes up to the end of
	 * the last message are sent: everything after that point, including the
	 * assistant turn and the tool results that do not exist yet, is written by the
	 * request that actually arrives.
	 * @param scope - the stream scope the just-finished request ran in.
	 * @param capture - that request's URL, headers, body and gzip decision.
	 */
	const openPrewarm = async (scope, capture) => {
		const key = prewarmKey(scope);
		if (key === undefined || prewarmBlocked.has(capture.url)) return;
		const existing = prewarms.get(key);
		if (existing !== undefined) dropPrewarm(existing);
		const prefix = prewarmPrefix(capture.body);
		if (prefix === undefined) return;
		const encoder = createWireEncoder(capture.gzip);
		let head;
		try {
			head = await encoder.prefix(prefix);
		} catch {
			encoder.dispose();
			return;
		}
		let stream;
		const body = new ReadableStream({
			start(controller) {
				stream = controller;
			}
		});
		const abort = new AbortController();
		const headers = { ...capture.headers };
		for (const field of Object.keys(headers)) {
			if (field.toLowerCase() === "content-length") delete headers[field];
		}
		if (capture.gzip === true) headers["content-encoding"] = "gzip";
		const entry = {
			key,
			prefix,
			url: capture.url,
			headers: capture.headers,
			encoder,
			stream,
			abort,
			dropped: false,
			settled: false,
			createdAt: performance.now()
		};
		entry.response = realFetch(capture.url, { method: "POST", headers, body, duplex: "half", signal: abort.signal });
		entry.response.then(() => {
			entry.settled = true;
		}, () => {
			entry.settled = true;
		});
		try {
			stream.enqueue(head);
		} catch {
			dropPrewarm(entry);
			return;
		}
		entry.timer = setTimeout(() => dropPrewarm(entry), state.prewarmHoldMs);
		// Bound how many conversations hold one at a time, oldest first.
		while (prewarms.size >= state.prewarmPoolSize) {
			const oldest = prewarms.values().next().value;
			if (oldest === undefined) break;
			dropPrewarm(oldest);
		}
		prewarms.set(key, entry);
		ctx.logger?.debug?.(`llm-request-gzip: pre-sent ${head.byteLength} bytes of the next ${scope.provider} request`);
	};

	/**
	 * Claim a held request for an arriving model request, but only when the body
	 * really does continue the pre-sent bytes and every header still agrees.
	 * Anything else abandons it and lets the request go out normally.
	 * @returns the entry plus the bytes still to write, or `undefined`.
	 */
	const claimPrewarm = (scope, input, init) => {
		const key = prewarmKey(scope);
		if (key === undefined) return undefined;
		const entry = prewarms.get(key);
		if (entry === undefined) return undefined;
		if (entry.settled === true) {
			dropPrewarm(entry);
			return undefined;
		}
		if (init === null || typeof init !== "object" || typeof init.body !== "string" || !init.body.startsWith(entry.prefix)) {
			dropPrewarm(entry);
			return undefined;
		}
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
		if (url !== entry.url || !headersMatch(entry.headers, init.headers)) {
			dropPrewarm(entry);
			return undefined;
		}
		clearTimeout(entry.timer);
		prewarms.delete(key);
		return { entry, delta: init.body.slice(entry.prefix.length) };
	};

	/**
	 * Finish a claimed request and hand its response to the adapter.
	 * @returns the response, or `undefined` when the request must be sent again.
	 */
	const completePrewarm = async (claimed, init, scope) => {
		const { entry, delta } = claimed;
		if (init.signal !== undefined && init.signal !== null) {
			if (init.signal.aborted === true) {
				dropPrewarm(entry);
				return undefined;
			}
			init.signal.addEventListener("abort", () => entry.abort.abort(), { once: true });
		}
		let response;
		try {
			entry.stream.enqueue(await entry.encoder.finish(delta));
			entry.stream.close();
			response = await entry.response;
		} catch {
			dropPrewarm(entry);
			ctx.logger?.warn?.("llm-request-gzip: pre-transmission failed; sending the request normally");
			return undefined;
		}
		if (!response.ok) {
			prewarmBlocked.add(entry.url);
			ctx.logger?.warn?.(`llm-request-gzip: ${entry.url} answered ${response.status} to a pre-transmitted request; pre-transmission is off for it`);
			if (isShapeRejection(response.status)) return undefined;
		}
		if (scope.record !== undefined && scope.record !== null) {
			timing.notePrewarm(scope.record, {
				prefixBytes: entry.prefix.length,
				deltaBytes: delta.length,
				holdMs: Math.round(performance.now() - entry.createdAt)
			});
		}
		return response;
	};

	// Every held request belongs to this plugin's fiber.
	ctx.effect(() => () => {
		for (const entry of [...prewarms.values()]) dropPrewarm(entry);
	});

	//#endregion

	/**
	 * Tag every streaming model call with its provider for the duration of that
	 * call, so the `fetch` patch can tell two routes on one endpoint apart, and
	 * open one timing measurement for it. Each iterator resumption runs inside
	 * the scope, because the adapters await (image serialization, file upload)
	 * before they reach `fetch`.
	 */
	ctx.on("llm/stream", (options, next) => {
		const inner = next();
		const call = options === null || typeof options !== "object" ? {} : options;
		const provider = call.provider;
		if (typeof provider !== "string" || provider.length === 0) return inner;
		if (inner === null || typeof inner !== "object" || typeof inner[Symbol.asyncIterator] !== "function") return inner;
		// Attribution is needed for gzip either way; a measurement is opened only
		// while the Request timing feature is on, so a deployment that hides the
		// view pays nothing for it.
		const record = state.timing
			? timing.begin({
				provider,
				model: typeof call.model === "string" ? call.model : null,
				sessionId: call.sessionId === undefined ? null : String(call.sessionId),
				purpose: call.purpose ?? null
			})
			: null;
		const policy = state.policies.get(provider);
		const scope = {
			provider,
			model: typeof call.model === "string" ? call.model : null,
			sessionId: call.sessionId === undefined ? null : String(call.sessionId),
			purpose: call.purpose ?? null,
			prewarm: policy !== undefined && policy.prewarm === true,
			record,
			capture: undefined
		};
		const note = (act) => {
			if (record !== null) act();
		};
		/**
		 * The kind of ending this step reports. `tool-calls` is the one that means
		 * another step follows; anything else ends the turn, and the pre-opened
		 * request has nothing left to serve.
		 */
		let finishKind;
		return {
			[Symbol.asyncIterator]() {
				const iterator = inner[Symbol.asyncIterator]();
				const scoped = (run) => attribution.run(scope, run);
				return {
					next: async (...args) => {
						let result;
						try {
							result = await scoped(() => iterator.next(...args));
						} catch (error) {
							note(() => timing.finish(record, performance.now(), "error"));
							throw error;
						}
						if (result.value !== null && typeof result.value === "object" && result.value.type === "finish") finishKind = result.value.reason?.kind;
						note(() => timing.observeChunk(record, result.value, performance.now()));
						if (result.done === true) {
							note(() => timing.finish(record, performance.now()));
							if (finishKind !== "tool-calls") dropPrewarmFor(scope);
						}
						return result;
					},
					return: (value) => {
						note(() => timing.finish(record, performance.now()));
						if (finishKind !== "tool-calls") dropPrewarmFor(scope);
						return typeof iterator.return === "function" ? scoped(() => iterator.return(value)) : Promise.resolve({ done: true, value });
					},
					throw: (error) => {
						note(() => timing.finish(record, performance.now(), "error"));
						return typeof iterator.throw === "function" ? scoped(() => iterator.throw(error)) : Promise.reject(error);
					}
				};
			}
		};
	});

	/**
	 * Consume undici's own transport diagnostics.
	 *
	 * The channels are process-wide, and — decisively — on a pooled keep-alive
	 * connection the response-side diagnostics run inside the async context of
	 * whichever request first opened that socket. Reading the ambient
	 * measurement there would attribute `headers` back to an older, already
	 * finished request, which is why the server phase would go missing on every
	 * request but the first.
	 *
	 * `undici:request:create` still runs in the caller's own context, so the
	 * measurement is paired with the request object once, by identity, and every
	 * later diagnostic is looked up through that pairing.
	 */
	ctx.effect(() => {
		const inFlight = new WeakMap();

		const onCreated = (message) => {
			const request = message === null || typeof message !== "object" ? undefined : message.request;
			const record = attribution.getStore()?.record;
			if (request === undefined || record === undefined || record === null) return;
			if (!timing.claimsRequest(record, request)) return;
			inFlight.set(request, record);
		};

		const onTransport = (sink) => (message) => {
			const request = message === null || typeof message !== "object" ? undefined : message.request;
			const record = request === undefined ? undefined : inFlight.get(request);
			if (record === undefined) return;
			if (sink === "response-bytes") {
				timing.noteResponseBytes(record, message.chunk?.byteLength);
				return;
			}
			timing.notePhase(record, sink.slice("phase:".length), performance.now());
			if (sink === "phase:headers") timing.noteResponseEncoding(record, diagnosticHeader(message.response?.headers, "content-encoding"));
		};

		const pairs = [[REQUEST_CREATED_CHANNEL, onCreated], ...TRANSPORT_CHANNELS.map(([channel, sink]) => [channel, onTransport(sink)])];
		const unsubscribes = pairs.map(([channel, listener]) => {
			diagnosticsChannel.subscribe(channel, listener);
			return () => diagnosticsChannel.unsubscribe(channel, listener);
		});
		return () => {
			for (const unsubscribe of unsubscribes) unsubscribe();
		};
	});

	// The ledger reaches the browser over the product's authenticated API
	// channel, so the page needs no bespoke transport and no token of its own.
	ctx.inject(["connection"], (connectionCtx) => {
		connectionCtx.connection.fetch.register({
			path: TIMINGS_PATH,
			methods: ["GET"],
			requestBody: "buffered",
			fetch: async (request) => {
				const sessionId = new URL(request.url).searchParams.get("sessionId");
				return Response.json({ measurements: timing.snapshot(sessionId) });
			}
		});
	});

	/** The original transport, captured before this plugin replaces it. */
	const realFetch = globalThis.fetch;

	/**
	 * Decide whether this one call is in scope, and rewrite it if so.
	 *
	 * Timing is bookkept before the rewrite, on the caller's original body: the
	 * model request is the string-bodied call made inside the stream's own async
	 * scope, which is exactly what distinguishes it from the `FormData` Files API
	 * upload that may precede it.
	 *
	 * @param input - the `fetch` first argument.
	 * @param init - the `fetch` second argument.
	 * @returns the rewritten call, or `undefined` to pass the call through.
	 */
	const planRequest = (input, init) => {
		if (init === null || typeof init !== "object") return undefined;
		if (typeof input !== "string" && !(input instanceof URL)) return undefined;
		const url = typeof input === "string" ? input : input.href;
		const store = attribution.getStore();
		const record = store?.record;
		const measured = record !== undefined && record !== null && typeof init.body === "string";
		if (measured) timing.noteFetch(record, url, Buffer.byteLength(init.body, "utf8"));
		// Remember what this request looked like, so the next one for the same
		// conversation can have its shared history put on the wire early.
		const isModelBody = typeof init.body === "string";
		if (store !== undefined && store !== null && isModelBody && store.capture === undefined) {
			store.capture = { body: init.body, headers: plainHeaders(init.headers), url, gzip: false };
		}
		const headers = init.headers;
		if (readHeader(headers, CONTENT_ENCODING) !== undefined) return undefined;
		const policy = resolvePolicy({
			url,
			provider: store?.provider,
			policies: state.policies,
			byEndpoint: state.byEndpoint
		});
		const plan = planGzip({
			body: init.body,
			policy,
			hasContentEncoding: undefined,
			byteLength: (text) => Buffer.byteLength(text, "utf8"),
			gzip: (text) => gzipSync(Buffer.from(text, "utf8"))
		});
		if (isModelBody && store?.capture !== undefined && store.capture.body === init.body) store.capture.gzip = plan !== undefined;
		if (plan === undefined) return undefined;
		if (measured) timing.noteSent(record, plan.compressedBytes);
		return {
			...plan,
			provider: store?.provider,
			init: { ...init, headers: withGzipHeader(headers), body: plan.body }
		};
	};

	/**
	 * The patched transport. Any failure inside the rewrite falls back to the
	 * untouched call: this plugin must never be able to break model requests.
	 */
	const patchedFetch = async function patchedFetch(input, init) {
		let planned;
		try {
			// A held request for this very conversation may already be open with the
			// shared history written. Claim it, finish it with the increment, and
			// hand its response straight to the adapter.
			const scope = attribution.getStore();
			if (scope !== undefined && scope.prewarm === true) {
				const claimed = claimPrewarm(scope, input, init);
				if (claimed !== undefined) {
					const response = await completePrewarm(claimed, init, scope);
					if (response !== undefined) return response;
				}
			}
			planned = planRequest(input, init);
			// The shared history this request carries is exactly the history the next
			// one will repeat, and it is known the moment this request goes out — so
			// the next request is opened now and the upload overlaps the model call
			// itself, not just the tools that follow it.
			if (scope !== undefined && scope.prewarm === true && scope.capture !== undefined) {
				openPrewarm(scope, scope.capture).catch(() => {});
			}
		} catch (error) {
			ctx.logger?.warn?.("llm-request-gzip: skipped compression after an error; sending the request uncompressed");
			ctx.logger?.warn?.(error);
			planned = undefined;
		}
		if (planned === undefined) return realFetch.call(this, input, init);
		ctx.logger?.info?.(`llm-request-gzip: ${planned.provider ?? "endpoint-matched"} request compressed ${planned.originalBytes} -> ${planned.compressedBytes} bytes`);
		return realFetch.call(this, input, planned.init);
	};

	ctx.effect(() => {
		globalThis.fetch = patchedFetch;
		return () => {
			if (globalThis.fetch === patchedFetch) globalThis.fetch = realFetch;
		};
	});
}
