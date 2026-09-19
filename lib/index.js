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
import { gzipSync } from "node:zlib";
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
import { createTimingStore } from "./timing.js";

/** Host plugin name; also the settings namespace this plugin owns. */
export const name = "llm-request-gzip";

/** Settings namespace key. Must be a lowercase hyphenated identifier. */
export const NS = name;

/** Header this plugin adds; its presence means the request is already compressed. */
const CONTENT_ENCODING = "content-encoding";

/** Composition base: everything off until the user opts a provider in. */
const BASE = { providers: {} };

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
		minBytes: z.number().step(1).min(0).default(DEFAULT_MIN_BYTES).description("Skip compression below this request-body size, in bytes.")
	})).default({}).description("Per-provider request-body compression policy."),
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
	const state = { policies: new Map(), byEndpoint: new Map(), timing: true };
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
		const scope = record === null ? { provider } : { provider, record };
		const note = (act) => {
			if (record !== null) act();
		};
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
						note(() => timing.observeChunk(record, result.value, performance.now()));
						if (result.done === true) note(() => timing.finish(record, performance.now()));
						return result;
					},
					return: (value) => {
						note(() => timing.finish(record, performance.now()));
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
			if (request === undefined || record === undefined) return;
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
		const measured = record !== undefined && typeof init.body === "string";
		if (measured) timing.noteFetch(record, url, Buffer.byteLength(init.body, "utf8"));
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
			planned = planRequest(input, init);
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
