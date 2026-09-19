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
import { headersMatch, isShapeRejection, predictAssistantIncrement, prewarmPrefix } from "./prewarm.js";
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

/** Multiple of the per-conversation pool that may be held across all conversations. */
const TOTAL_HELD_MULTIPLIER = 8;

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

	/**
	 * Held requests per conversation, oldest first.
	 *
	 * The pool exists because a request's worth of bytes does not reach the far
	 * end instantly: the longer the history, the longer a relay chain needs to
	 * carry it. Members are therefore opened at staggered moments and kept
	 * advancing, so whichever one is consumed has already been in flight for
	 * several steps rather than for one.
	 */
	const prewarms = new Map();

	/**
	 * Endpoints that answered a pre-transmitted request badly. A refusal there is
	 * far more likely to be about the chunked body than about the request, so the
	 * endpoint is never pre-warmed again for the life of the process.
	 */
	const prewarmBlocked = new Set();

	/**
	 * Providers whose predicted assistant turn did not match the adapter's bytes.
	 * A prediction is a bet, and a lost bet costs a whole held request, so one
	 * loss switches the fill off for that provider and leaves the pool advancing
	 * on verbatim slices alone.
	 */
	const assistantFillDisabled = new Set();

	/** The key a conversation's members are filed under, or `undefined` to skip it. */
	const prewarmKey = (scope) => {
		if (scope.prewarm !== true || scope.provider === undefined) return undefined;
		// Compaction and title requests carry a different history, and a different
		// body shape; they neither open nor consume held requests.
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
	 * Encode one body in parts whose concatenation is a single valid stream: a
	 * second gzip member or a second JSON chunk would either break decompression
	 * or double the framing, so the gzip case keeps ONE deflate stream open across
	 * every part and flushes it between them.
	 */
	const createWireEncoder = (gzipEnabled) => {
		if (gzipEnabled !== true) {
			const encoder = new TextEncoder();
			return {
				async write(text) {
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
		const flush = (text, end) => new Promise((resolve, reject) => {
			stream.once("error", reject);
			const done = () => {
				stream.removeListener("error", reject);
				resolve(take());
			};
			if (end === true) {
				stream.once("end", done);
				stream.end(Buffer.from(text));
				return;
			}
			stream.write(Buffer.from(text));
			stream.flush(zlibConstants.Z_SYNC_FLUSH, done);
		});
		return {
			async write(text) {
				return flush(text, false);
			},
			async finish(text) {
				// `end(chunk, callback)` reports the write, not the drain: waiting on
				// it would hand back a truncated body with no gzip footer.
				return flush(text, true);
			},
			dispose() {
				try {
					stream.destroy();
				} catch {}
			}
		};
	};

	/** Set once the plugin is disposed, so an in-flight sync cannot open more. */
	let prewarmDisposed = false;

	/**
	 * The undici request each measurement is currently listening to.
	 *
	 * A held member's request is created while the *previous* step's stream is
	 * still the ambient context, so it must not be attributed then — it is
	 * recorded here instead and re-pointed at the measurement that claims it.
	 * Without that, a pre-transmitted row would lose its transport phases and the
	 * previous row would be charged with its response bytes.
	 */
	const requestOwner = new WeakMap();

	/** The member whose `fetch` is being called right now, if any. */
	let openingMember;

	/** The members filed for one conversation. */
	const membersOf = (key) => prewarms.get(key) ?? [];

	/**
	 * Restart a member's hold timer. A member that has just been advanced is
	 * provably still wanted — the conversation moved on and its bytes were still a
	 * prefix — so the timer measures idleness, not age. Without this, a long step
	 * retires the member that the following request was going to use.
	 */
	const refreshHold = (entry) => {
		if (entry.dropped === true) return;
		clearTimeout(entry.timer);
		entry.timer = setTimeout(() => dropMember(entry), state.prewarmHoldMs);
	};

	/**
	 * Keep the number of open held requests bounded in total, across every
	 * conversation, by retiring the oldest first. The per-conversation pool is
	 * what buys lead time; this only stops many conversations from multiplying it
	 * without limit.
	 */
	const enforceTotalCap = () => {
		const cap = state.prewarmPoolSize * TOTAL_HELD_MULTIPLIER;
		let total = 0;
		for (const list of prewarms.values()) total += list.length;
		while (total > cap) {
			let oldest;
			for (const list of prewarms.values()) {
				for (const member of list) if (oldest === undefined || member.createdAt < oldest.createdAt) oldest = member;
			}
			if (oldest === undefined) break;
			dropMember(oldest);
			total -= 1;
		}
	};

	/** Abandon one held request: stop its timer, fail its body, close its socket. */
	const dropMember = (entry) => {
		if (entry.dropped === true) return;
		entry.dropped = true;
		clearTimeout(entry.timer);
		for (const [key, list] of prewarms) {
			const next = list.filter((member) => member !== entry);
			if (next.length === list.length) continue;
			if (next.length === 0) prewarms.delete(key);
			else prewarms.set(key, next);
		}
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

	/** Abandon every member of one conversation, and the pool with it. */
	const dropPool = (key) => {
		for (const entry of [...membersOf(key)]) dropMember(entry);
		prewarms.delete(key);
	};

	/** Abandon the pool of the conversation a step belonged to. */
	const dropPoolFor = (scope) => {
		const key = prewarmKey(scope);
		if (key === undefined) return;
		dropPool(key);
	};

	/** Open one held request carrying `prefix`, and put that prefix on the wire. */
	const openMember = async (descriptor, prefix) => {
		const encoder = createWireEncoder(descriptor.gzip);
		let head;
		try {
			head = await encoder.write(prefix);
		} catch {
			encoder.dispose();
			return undefined;
		}
		let stream;
		const body = new ReadableStream({
			start(controller) {
				stream = controller;
			}
		});
		const abort = new AbortController();
		const headers = { ...descriptor.headers };
		for (const field of Object.keys(headers)) {
			if (field.toLowerCase() === "content-length") delete headers[field];
		}
		if (descriptor.gzip === true) headers["content-encoding"] = "gzip";
		const entry = {
			url: descriptor.url,
			headers: descriptor.headers,
			gzip: descriptor.gzip,
			prefix,
			encoder,
			stream,
			abort,
			dropped: false,
			settled: false,
			filled: false,
			createdAt: performance.now()
		};
		openingMember = entry;
		try {
			entry.response = realFetch(descriptor.url, { method: "POST", headers, body, duplex: "half", signal: abort.signal });
		} finally {
			openingMember = undefined;
		}
		entry.response.then(() => {
			entry.settled = true;
		}, () => {
			entry.settled = true;
		});
		try {
			stream.enqueue(head);
		} catch {
			dropMember(entry);
			return undefined;
		}
		refreshHold(entry);
		return entry;
	};

	/** Extend one member by `text`, which must be the bytes that follow its prefix. */
	const appendMember = async (entry, text) => {
		if (entry.dropped === true) return false;
		if (text.length === 0) return true;
		try {
			entry.stream.enqueue(await entry.encoder.write(text));
			return true;
		} catch {
			return false;
		}
	};

	/**
	 * Bring a conversation's pool up to date after a request was captured: advance
	 * every member to the newly known prefix — with bytes taken verbatim from that
	 * request, never reconstructed — drop the ones that no longer continue it, and
	 * open members until the pool is full.
	 * @param scope - the stream scope the captured request ran in.
	 * @param capture - that request's URL, headers, body and gzip decision.
	 */
	const syncPrewarm = async (scope, capture) => {
		if (prewarmDisposed) return;
		const key = prewarmKey(scope);
		if (key === undefined || prewarmBlocked.has(capture.url)) return;
		const frontier = prewarmPrefix(capture.body);
		if (frontier === undefined) {
			dropPool(key);
			return;
		}
		const descriptor = { url: capture.url, headers: capture.headers, gzip: capture.gzip === true };
		const kept = [];
		for (const member of membersOf(key)) {
			if (member.url !== descriptor.url || member.settled === true || !frontier.startsWith(member.prefix)) {
				dropMember(member);
				continue;
			}
			if (!(await appendMember(member, frontier.slice(member.prefix.length)))) {
				dropMember(member);
				continue;
			}
			member.prefix = frontier;
			refreshHold(member);
			kept.push(member);
		}
		while (!prewarmDisposed && kept.length < state.prewarmPoolSize) {
			const opened = await openMember(descriptor, frontier);
			if (opened === undefined) break;
			kept.push(opened);
		}
		if (prewarmDisposed) {
			for (const member of kept) dropMember(member);
			return;
		}
		enforceTotalCap();
		if (kept.length === 0) prewarms.delete(key);
		else prewarms.set(key, kept);
	};

	/**
	 * Add the assistant turn that just finished to every member of the pool, so
	 * that turn is already in flight while the tools run. The bytes are a
	 * prediction, and one that turns out wrong is caught when the next request
	 * claims a member — which also switches this fill off for the provider.
	 */
	const fillAssistant = (scope, assistant) => {
		const key = prewarmKey(scope);
		if (key === undefined || scope.capture === undefined) return;
		if (scope.provider !== undefined && assistantFillDisabled.has(scope.provider)) return;
		const predicted = predictAssistantIncrement(scope.capture.body, assistant);
		if (predicted === undefined) return;
		for (const member of membersOf(key)) {
			if (member.prefix !== predicted.from) continue;
			if (member.settled === true) continue;
			appendMember(member, predicted.appended).then((ok) => {
				if (ok) {
					member.prefix = predicted.prefix;
					member.filled = true;
					refreshHold(member);
				} else dropMember(member);
			});
		}
	};

	/**
	 * Claim a held request for an arriving model request: the oldest member whose
	 * bytes the arriving body continues, whose headers still agree, and whose
	 * endpoint is the same. Anything else abandons the pool and lets the request
	 * go out normally.
	 * @returns the entry plus the bytes still to write, or `undefined`.
	 */
	const claimPrewarm = (scope, input, init) => {
		const key = prewarmKey(scope);
		if (key === undefined) return undefined;
		const miss = (reason) => {
			scope.prewarmMiss = reason;
			return undefined;
		};
		const members = membersOf(key);
		if (members.length === 0) return miss("empty");
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
		let chosen;
		let filled = false;
		if (init === null || typeof init !== "object" || typeof init.body !== "string") return miss("shape");
		for (const member of members) {
			if (member.url !== url || member.settled === true || !init.body.startsWith(member.prefix)) continue;
			if (!headersMatch(member.headers, init.headers)) continue;
			chosen = member;
			break;
		}
		if (chosen === undefined) {
			for (const member of members) if (member.filled === true) filled = true;
			dropPool(key);
			if (filled && scope.provider !== undefined) {
				assistantFillDisabled.add(scope.provider);
				ctx.logger?.warn?.("llm-request-gzip: the predicted assistant turn did not match; pre-transmission now advances on captured bytes only");
			}
			return miss(filled ? "fill" : "mismatch");
		}
		clearTimeout(chosen.timer);
		prewarms.set(key, members.filter((member) => member !== chosen));
		return { entry: chosen, delta: init.body.slice(chosen.prefix.length) };
	};

	/**
	 * Finish a claimed request and hand its response to the adapter.
	 * @returns the response, or `undefined` when the request must be sent again.
	 */
	const completePrewarm = async (claimed, init, scope) => {
		const { entry, delta } = claimed;
		if (init.signal !== undefined && init.signal !== null) {
			if (init.signal.aborted === true) {
				dropMember(entry);
				return undefined;
			}
			init.signal.addEventListener("abort", () => entry.abort.abort(), { once: true });
		}
		let response;
		try {
			// From here the member is this step's request, so its transport
			// diagnostics belong to this step's row.
			if (entry.request !== undefined && scope.record !== undefined && scope.record !== null) requestOwner.set(entry.request, scope.record);
			entry.stream.enqueue(await entry.encoder.finish(delta));
			entry.stream.close();
			response = await entry.response;
		} catch {
			dropMember(entry);
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
		prewarmDisposed = true;
		for (const key of [...prewarms.keys()]) dropPool(key);
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
			prewarmMiss: undefined,
			record,
			capture: undefined
		};
		const note = (act) => {
			if (record !== null) act();
		};
		/**
		 * The kind of ending this step reports. `tool-calls` is the one that means
		 * another step follows; anything else ends the turn, and the pool has
		 * nothing left to serve.
		 */
		let finishKind;
		/** The turn as it streamed, used to predict the bytes the next request adds. */
		let assistantText = "";
		const assistantCalls = new Map();
		const noteAssistant = (chunk) => {
			if (chunk === null || typeof chunk !== "object") return;
			if (chunk.type === "text-delta" && typeof chunk.text === "string") assistantText += chunk.text;
			else if (chunk.type === "tool-call-delta") {
				const call = assistantCalls.get(chunk.id) ?? { id: chunk.id, name: undefined, arguments: "" };
				if (chunk.name !== undefined) call.name = chunk.name;
				if (chunk.argumentsDelta !== undefined) call.arguments += chunk.argumentsDelta;
				assistantCalls.set(chunk.id, call);
			}
		};
		/**
		 * A step that asks for tools is followed by another request, so the pool is
		 * kept — and the assistant turn is added to it now, while the tools run.
		 * Anything else ends the turn, and the whole pool is destroyed.
		 */
		const settlePrewarm = () => {
			if (finishKind !== "tool-calls") {
				dropPoolFor(scope);
				return;
			}
			fillAssistant(scope, { text: assistantText, toolCalls: [...assistantCalls.values()] });
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
						if (result.value !== null && typeof result.value === "object" && result.value.type === "finish") finishKind = result.value.reason?.kind;
						else noteAssistant(result.value);
						note(() => timing.observeChunk(record, result.value, performance.now()));
						if (result.done === true) {
							note(() => timing.finish(record, performance.now()));
							settlePrewarm();
						}
						return result;
					},
					return: (value) => {
						note(() => timing.finish(record, performance.now()));
						settlePrewarm();
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
		const onCreated = (message) => {
			const request = message === null || typeof message !== "object" ? undefined : message.request;
			if (request === undefined) return;
			// A held member belongs to whichever step later claims it, not to the
			// step whose stream happens to be running when it is opened.
			if (openingMember !== undefined) {
				openingMember.request = request;
				return;
			}
			const record = attribution.getStore()?.record;
			if (record === undefined || record === null) return;
			if (!timing.claimsRequest(record, request)) return;
			requestOwner.set(request, record);
		};

		const onTransport = (sink) => (message) => {
			const request = message === null || typeof message !== "object" ? undefined : message.request;
			const record = request === undefined ? undefined : requestOwner.get(request);
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
					// Record the request first: the measurement must be anchored at the
					// moment it is issued — the claim — and not after its response has
					// already arrived, or every phase would come out negative.
					planRequest(input, init);
					const response = await completePrewarm(claimed, init, scope);
					if (response !== undefined) {
						// Served from a held member, so nothing was sent — but the pool
						// still has to be brought up to date for the step after.
						if (scope.capture !== undefined) syncPrewarm(scope, scope.capture).catch(() => {});
						return response;
					}
				}
			}
			planned = planRequest(input, init);
			if (scope !== undefined && scope.prewarmMiss !== undefined && scope.record !== undefined && scope.record !== null) {
				timing.notePrewarmMiss(scope.record, scope.prewarmMiss);
			}
			// The shared history this request carries is exactly the history the next
			// one will repeat, and it is known the moment this request goes out — so
			// the next request is opened now and the upload overlaps the model call
			// itself, not just the tools that follow it.
			if (scope !== undefined && scope.prewarm === true && scope.capture !== undefined) {
				syncPrewarm(scope, scope.capture).catch(() => {});
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
