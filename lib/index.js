/**
 * Per-provider request-body compression, pre-transmission, and timing for model
 * requests.
 *
 * Response compression is already on in Node: undici's `fetch` sends
 * `accept-encoding: gzip, deflate` by default and decompresses the reply, so
 * there is nothing to enable on that side. The switch that actually moves
 * bytes is the **request** direction: a long body is compressed — brotli by
 * default, gzip where brotli is unavailable or refused — and announced with the
 * matching `content-encoding`. On a real session that is 3.8 MB down to 1.46 MB,
 * and what matters beyond the ratio is that the fixed fields can then be
 * pre-transmitted, leaving a few hundred bytes for the request itself to write.
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
 * @module dsh-plugin-model-request-accelerator
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import diagnosticsChannel from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { constants as zlibConstants, brotliCompressSync, createBrotliCompress, createGzip, gzipSync } from "node:zlib";
import z from "@deepseek-ai/schemastery";
import {
	compilePolicies,
	DEFAULT_MIN_BYTES,
	indexEndpoints,
	planCompression,
	readEndpoint,
	readHeader,
	resolvePolicy,
	withEncodingHeader
} from "./compress.js";
import { headersMatch, isShapeRejection, messagesPrefixEnd, moveMessagesLast, prewarmPrefix } from "./prewarm.js";
import { openLedger } from "./ledger.js";
import { isNewer, versionFromPackage } from "./version.js";
import { createTimingStore } from "./timing.js";

/**
 * Encode one request body. Brotli is preferred when the runtime has it — on the
 * JSON these adapters send it is typically 5–15% smaller than gzip — and it is
 * an endpoint's refusal, not a guess, that moves a route back to gzip.
 * @param text - the serialized request body.
 * @param encoding - `'br'` or `'gzip'`.
 * @returns the compressed bytes.
 */
function encodeBody(text, encoding) {
	const buffer = Buffer.from(text, "utf8");
	return encoding === "br" ? brotliCompressSync(buffer, { params: brotliParams(buffer.length) }) : gzipSync(buffer);
}

/**
 * Brotli parameters that are worth their own cost.
 *
 * Brotli defaults to quality 11, which spends about a second of CPU per
 * megabyte — synchronously, in the request path, for roughly another 15% over
 * quality 9. Quality 9 is a few percent better than gzip at a comparable time,
 * which is the trade this plugin wants. The size hint lets the encoder size its
 * window up front.
 * @param size - the body size, when it is known.
 * @returns the zlib parameters.
 */
function brotliParams(size) {
	const params = { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 };
	if (Number.isFinite(size) && size > 0) params[zlibConstants.BROTLI_PARAM_SIZE_HINT] = size;
	return params;
}

/** Host plugin name; also the settings namespace this plugin owns. */
export const name = "model-request-accelerator";

/** Settings namespace key. Must be a lowercase hyphenated identifier. */
export const NS = name;

/** Header this plugin adds; its presence means the request is already compressed. */
const CONTENT_ENCODING = "content-encoding";

/** Composition base: everything off until the user opts a provider in. */
const BASE = { providers: {} };

/** How long a pre-opened request is held open by default. */
const DEFAULT_PREWARM_HOLD_MS = 120000;

/**
 * How many held requests one conversation keeps. They are opened at staggered
 * moments and advanced as content becomes known, so they carry progressively
 * longer prefixes; a request claims the oldest one it continues. More members
 * mean a longer lead time and more connections held open.
 */
const DEFAULT_PREWARM_POOL_SIZE = 3;

/** How long a changed session's ledger waits before it is written. */
const SAVE_DEBOUNCE_MS = 300;

/** Multiple of the per-conversation pool that may be held across all conversations. */
const TOTAL_HELD_MULTIPLIER = 8;

/** Whether this runtime can brotli-encode at all. */
const BROTLI_AVAILABLE = typeof brotliCompressSync === "function" && typeof createBrotliCompress === "function";

/** How many leading bytes two strings share. */
function sharedBytes(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return 0;
	const max = Math.min(a.length, b.length);
	let index = 0;
	while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
	return index;
}

/** The installed package root — this file lives in its `lib/`. */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** How long the published version may take to answer. */
const UPDATE_FETCH_TIMEOUT_MS = 5000;

/** How long a fast-forward pull may take. */
const UPDATE_PULL_TIMEOUT_MS = 60000;

/** Authenticated browser route reporting what real traffic taught us per endpoint. */
const ENDPOINTS_PATH = "/api/model-request-accelerator/endpoints";

/** Authenticated browser route for the version and the update action. */
const VERSION_PATH = "/api/model-request-accelerator/version";

/** Authenticated browser route serving the timing ledger. */
const TIMINGS_PATH = "/api/model-request-accelerator/timings";

/** The namespace this plugin used before it was renamed. */
const LEGACY_NS = "llm-request-gzip";

/**
 * Copy a stored section from the plugin's former name into the current one, once.
 *
 * Only the *user* layer is read, so nothing is invented: a user who never set
 * anything keeps exactly nothing. The write happens only when the current
 * namespace is still untouched, which makes this idempotent and makes it stand
 * down the moment the user configures the plugin under its new name.
 * @param settings - the settings service.
 */
function migrateLegacySettings(settings) {
	const descriptors = settings.describe?.() ?? [];
	const legacy = descriptors.find((entry) => entry.ns === LEGACY_NS);
	const own = descriptors.find((entry) => entry.ns === NS);
	const carried = legacy?.user;
	if (carried === null || typeof carried !== "object" || Object.keys(carried).length === 0) return;
	if (own?.user !== null && typeof own?.user === "object" && Object.keys(own.user).length > 0) return;
	settings.update(NS, carried).catch(() => {});
}

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
		enabled: z.boolean().default(false).description("Send this provider's model requests compressed."),
		minBytes: z.number().step(1).min(0).default(DEFAULT_MIN_BYTES).description("Skip compression below this request-body size, in bytes."),
		prewarm: z.boolean().default(false).description("Put this conversation's shared history on the wire before the next request needs it, leaving only the increment for the real request. Needs an endpoint that accepts a chunked body."),
		encoding: z.union([z.const("auto"), z.const("gzip")]).description("Request-body algorithm for this provider. Overrides the section default.")
	})).default({}).description("Per-provider request-body policy."),
	encoding: z.union([z.const("auto"), z.const("gzip")]).default("auto").description("Request-body algorithm. `auto` prefers brotli and falls back to gzip when the runtime lacks it or the endpoint refuses it; `gzip` never tries brotli."),
	prewarmHoldMs: z.number().step(1).min(1000).default(DEFAULT_PREWARM_HOLD_MS).description("How long a pre-opened request may sit idle before it is abandoned. The timer restarts whenever it advances."),
	prewarmPoolSize: z.number().step(1).min(1).default(DEFAULT_PREWARM_POOL_SIZE).description("How many pre-opened requests one conversation keeps. More means a longer lead time and more connections held open."),
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
 * Register the settings section and its legacy namespace, attribute streaming
 * calls to their provider, patch the global `fetch` for the lifetime of this
 * plugin's fiber, serve the timing, endpoint-state and version routes, and open
 * the durable ledger.
 * @param ctx - Host context.
 */
export function apply(ctx) {
	const attribution = new AsyncLocalStorage();
	const state = { policies: new Map(), byEndpoint: new Map(), timing: true, prewarmHoldMs: DEFAULT_PREWARM_HOLD_MS, prewarmPoolSize: DEFAULT_PREWARM_POOL_SIZE };

	/**
	 * Endpoints that answered a brotli-encoded request with a shape rejection. A
	 * request body has no negotiation, so this is how "brotli is not usable here"
	 * gets learned — once, rather than on every request. It is per plugin
	 * instance, so a reload re-learns at the cost of one request.
	 */
	const brotliRefused = new Set();

	/**
	 * Endpoints that rejected a body with its conversation moved to the end. JSON objects
	 * are unordered, so this should not happen — but a hand-rolled relay may match
	 * on the body's shape, and one wasted request is a cheaper way to find that out
	 * than a broken conversation. Per plugin instance, like the other refusals, so
	 * reloading the plugin starts the learning over instead of inheriting a
	 * decision made by code that no longer exists.
	 */
	const reorderRefused = new Set();
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
		const settings = settingsCtx.settings;
		// This plugin was called `llm-request-gzip` before it grew past gzip, and
		// that name is still the key in settings.yaml. Registering it keeps the
		// stored section readable, so the rename can carry it across instead of
		// quietly reverting every provider to its defaults.
		// A stale section under the old name must never be able to fail this
		// registration and take the plugin down with it.
		try {
			if (typeof settings.register === "function") settings.register(LEGACY_NS, Config, { applies: "live" });
		} catch {}

		settings.installSection(ctx, NS, Config, BASE, {
			setSource: (next) => {
				source = next;
				refresh();
			},
			onChange: () => {
				refresh();
			}
		});
		migrateLegacySettings(settings);
	});
	ctx.on("settings/updated", () => {
		refresh();
	});

	/**
	 * The durable half of the timing ledger. These records describe one
	 * conversation, so they are stored per session and outlive a restart. A
	 * deployment without a storage backend leaves this undefined and the ledger
	 * stays memory-only, which is what it was before.
	 */
	let ledger;
	/**
	 * Look for a session's stored history, once per process.
	 *
	 * Called before a session's first record is numbered as well as from the route:
	 * restored ids have to be known before the first live one is allocated, or the
	 * merged list would carry duplicates.
	 * @param sessionId - the session key.
	 */
	const consultLedger = (sessionId) => {
		if (ledger === undefined || sessionId === null || sessionId === undefined || consulted.has(sessionId)) return;
		consulted.add(sessionId);
		try {
			timing.seed(sessionId, ledger.read(sessionId));
		} catch (error) {
			ledger = undefined;
			ctx.logger?.warn?.("model-request-accelerator: the durable timing store could not be read; showing only this run");
			ctx.logger?.warn?.(error);
		}
	};
	/** Debounced writes, one per session, so a burst of requests writes once. */
	const pendingWrites = new Map();
	/** Sessions whose stored history has been looked for in this process. */
	const consulted = new Set();

	/** Persist one session's rows shortly after they change. */
	const scheduleSave = (sessionId) => {
		if (ledger === undefined || sessionId === null || sessionId === undefined) return;
		clearTimeout(pendingWrites.get(sessionId));
		pendingWrites.set(sessionId, setTimeout(() => {
			pendingWrites.delete(sessionId);
			Promise.resolve(ledger.write(sessionId, timing.snapshot(sessionId))).catch((error) => {
				ctx.logger?.warn?.("model-request-accelerator: could not persist the timing ledger");
				ctx.logger?.warn?.(error);
			});
		}, SAVE_DEBOUNCE_MS));
	};

	ctx.inject(["storage"], (storageCtx) => {
		openLedger(storageCtx.get("storage"), (message) => ctx.logger?.warn?.(message)).then((opened) => {
			ledger = opened;
		}, (error) => {
			ctx.logger?.warn?.("model-request-accelerator: could not open the durable timing store");
			ctx.logger?.warn?.(error);
		});
	});

	// Writes still queued belong on disk before the domain closes under them.
	ctx.effect(() => () => {
		const queued = [...pendingWrites.entries()];
		pendingWrites.clear();
		const flushes = queued.map(([sessionId, timer]) => {
			clearTimeout(timer);
			if (ledger === undefined) return Promise.resolve();
			return Promise.resolve(ledger.write(sessionId, timing.snapshot(sessionId))).catch(() => {});
		});
		return Promise.all(flushes).then(() => (ledger === undefined ? undefined : ledger.close().catch(() => {})));
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
	 * Endpoints that answered a pre-transmitted request badly, and how many times
	 * in a row. This is the one thing shared across agents on purpose: whether an
	 * endpoint will take a chunked body is a property of the endpoint, not of the
	 * conversation asking. It is also the reason a transient server error must not
	 * condemn it — a single 5xx or rate limit would otherwise switch
	 * pre-transmission off for every agent until the process restarts.
	 */
	const prewarmBlocked = new Set();
	const endpointFailures = new Map();

	/** Consecutive failures an endpoint may answer before it is given up on. */
	const MAX_ENDPOINT_FAILURES = 3;

	/** Record one bad answer, condemning the endpoint only on repetition. */
	const noteEndpointFailure = (url, status) => {
		if (isShapeRejection(status)) {
			// It will not take a chunked body at all; retrying cannot help.
			prewarmBlocked.add(url);
			endpointFailures.delete(url);
			ctx.logger?.warn?.(`model-request-accelerator: ${url} answered ${status} to a pre-transmitted request; pre-transmission is off for it`);
			return;
		}
		const count = (endpointFailures.get(url) ?? 0) + 1;
		endpointFailures.set(url, count);
		if (count < MAX_ENDPOINT_FAILURES) {
			ctx.logger?.warn?.(`model-request-accelerator: ${url} answered ${status} to a pre-transmitted request (${count}/${MAX_ENDPOINT_FAILURES})`);
			return;
		}
		prewarmBlocked.add(url);
		endpointFailures.delete(url);
		ctx.logger?.warn?.(`model-request-accelerator: ${url} answered ${status} ${count} times in a row to pre-transmitted requests; pre-transmission is off for it`);
	};

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
	 * second codec member would break decompression and a second JSON chunk would
	 * double the framing, so each codec keeps ONE stream open across every part and
	 * flushes it between them — a sync flush for gzip, a brotli flush for brotli —
	 * so a receiver sees one body however many parts it arrived in.
	 */
	const createWireEncoder = (encoding) => {
		if (encoding !== "br" && encoding !== "gzip") {
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
		const stream = encoding === "br" ? createBrotliCompress({ params: brotliParams(0) }) : createGzip();
		const flushKind = encoding === "br" ? zlibConstants.BROTLI_OPERATION_FLUSH : zlibConstants.Z_SYNC_FLUSH;
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
			stream.flush(flushKind, done);
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
	 * One pool mutation at a time, per conversation.
	 *
	 * Syncing is fire-and-forget, so without this a sync started by the previous
	 * step can still be running when the next request claims a member — and it can
	 * decide that same member is stale and abort it out from under the handover.
	 * That is not hypothetical: it is what a claimed request failing mid-flight
	 * looks like, and it costs the whole upload.
	 */
	const poolLocks = new Map();
	const withPoolLock = (key, operation) => {
		const previous = poolLocks.get(key) ?? Promise.resolve();
		const result = previous.then(operation, operation);
		const settled = result.then(() => {}, () => {});
		poolLocks.set(key, settled);
		// Drop the entry once it is the tail of the chain, so a process that sees
		// many conversations does not keep a promise per conversation forever.
		settled.then(() => {
			if (poolLocks.get(key) === settled) poolLocks.delete(key);
		});
		return result;
	};

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

	/** Open one held request carrying `prefix`, and put that prefix on the wire. */
	const openMember = async (descriptor, prefix) => {
		const encoder = createWireEncoder(descriptor.encoding);
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
		if (descriptor.encoding === "br" || descriptor.encoding === "gzip") headers["content-encoding"] = descriptor.encoding;
		const entry = {
			url: descriptor.url,
			headers: descriptor.headers,
			encoding: descriptor.encoding,
			prefix,
			encoder,
			stream,
			abort,
			dropped: false,
			settled: false,
			wireBytes: 0,
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
			entry.wireBytes = head.length;
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
			const encoded = await entry.encoder.write(text);
			entry.wireBytes += encoded.length;
			entry.stream.enqueue(encoded);
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
	const syncPrewarm = (scope, capture) => {
		if (prewarmDisposed) return Promise.resolve();
		const key = prewarmKey(scope);
		if (key === undefined || prewarmBlocked.has(capture.url)) return Promise.resolve();
		return withPoolLock(key, () => syncPrewarmLocked(key, scope, capture));
	};

	/** The sync itself, called only while holding the conversation's lock. */
	const syncPrewarmLocked = async (key, scope, capture) => {
		if (prewarmDisposed) return;
		const frontier = prewarmPrefix(capture.body);
		if (frontier === undefined) {
			dropPool(key);
			return;
		}
		const descriptor = { url: capture.url, headers: capture.headers, encoding: capture.encoding };
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
	 * Claim a held request for an arriving model request: the oldest member whose
	 * bytes the arriving body continues, whose headers still agree, and whose
	 * endpoint is the same. Anything else abandons the pool and lets the request
	 * go out normally.
	 * @returns the entry plus the bytes still to write, or `undefined`.
	 */
	const claimPrewarm = (scope, input, init) => {
		const key = prewarmKey(scope);
		if (key === undefined) return undefined;
		return withPoolLock(key, () => claimPrewarmLocked(key, scope, input, init));
	};

	/** The claim itself, called only while holding the conversation's lock. */
	const claimPrewarmLocked = (key, scope, input, init) => {
		const miss = (reason) => {
			scope.prewarmMiss = reason;
			return undefined;
		};
		const members = membersOf(key);
		if (members.length === 0) {
			// A protocol whose body carries no conversation array can never be served,
			// and reporting "pool empty" for it every step would read as a fault.
			return miss(typeof init.body === "string" && messagesPrefixEnd(init.body) === undefined ? "unsupported" : "empty");
		}
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
		let chosen;
		if (init === null || typeof init !== "object" || typeof init.body !== "string") return miss("shape");
		for (const member of members) {
			if (member.url !== url || member.settled === true || !init.body.startsWith(member.prefix)) continue;
			if (!headersMatch(member.headers, init.headers)) continue;
			// Members can sit at different depths — an older one may have been
			// advanced less far — and the deepest match leaves the least to write.
			if (chosen === undefined || member.prefix.length > chosen.prefix.length) chosen = member;
		}
		if (chosen === undefined) {
			// Record how far the arriving body agrees with the best member. That one
			// number says where the bytes parted company — in the fixed fields, deep in
			// the history, or in the last message — rather than leaving it to be
			// inferred from unrelated evidence.
			let agreed = 0;
			let member = 0;
			for (const candidate of members) {
				member = Math.max(member, candidate.prefix.length);
				agreed = Math.max(agreed, sharedBytes(init.body, candidate.prefix));
			}
			scope.prewarmMissDetail = {
				agreed,
				member,
				body: typeof init.body === "string" ? init.body.length : null,
				messagesAt: typeof init.body === "string" ? init.body.indexOf(String.fromCharCode(34) + "messages" + String.fromCharCode(34) + ":[") : -1
			};
			dropPool(key);
			return miss("mismatch");
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
				scope.prewarmMiss = "aborted";
				return undefined;
			}
			init.signal.addEventListener("abort", () => entry.abort.abort(), { once: true });
		}
		let response;
		/** The compressed size of the increment, once it has been written. */
		let deltaWireBytes = 0;
		try {
			// From here the member is this step's request, so its transport
			// diagnostics belong to this step's row.
			if (entry.request !== undefined && scope.record !== undefined && scope.record !== null) requestOwner.set(entry.request, scope.record);
			const tail = await entry.encoder.finish(delta);
			deltaWireBytes = tail.length;
			entry.wireBytes += tail.length;
			entry.stream.enqueue(tail);
			entry.stream.close();
			response = await entry.response;
		} catch (error) {
			// A member can look alive when it is claimed and still die during the
			// handover: a held connection sits idle for tens of seconds, and a gateway
			// may close it in the meantime. That costs the whole upload, so it is
			// recorded on the row instead of looking like an ordinary request.
			dropMember(entry);
			scope.prewarmMiss = "failed";
			ctx.logger?.warn?.("model-request-accelerator: pre-transmission failed; sending the request normally");
			ctx.logger?.warn?.(error);
			return undefined;
		}
		if (response.ok) endpointFailures.delete(entry.url);
		else {
			noteEndpointFailure(entry.url, response.status);
			if (isShapeRejection(response.status)) {
				scope.prewarmMiss = "rejected";
				return undefined;
			}
		}
		if (scope.record !== undefined && scope.record !== null) {
			// The member was compressed as it was written, and this path deliberately
			// skips compressing the body again — so the wire size is reported from
			// what actually went out, and the row does not read as uncompressed.
			timing.noteSent(scope.record, entry.wireBytes, entry.encoding);
			// Report what actually went over the wire as well as what the delta is
			// made of. `prefixBytes` and `deltaBytes` are text; `deltaWireBytes` is the
			// compressed increment, and `tailBytes` is the part that lives after the
			// messages array — the tool schemas and the other trailing fields, which no
			// prefix can ever reach because they come last.
			const messagesEnd = messagesPrefixEnd(init.body);
			timing.notePrewarm(scope.record, {
				prefixBytes: entry.prefix.length,
				deltaBytes: delta.length,
				deltaWireBytes,
				tailBytes: messagesEnd === undefined ? null : init.body.length - messagesEnd,
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
		// A session's stored history is loaded before its first record is numbered,
		// so restored ids and live ids cannot collide.
		consultLedger(call.sessionId === undefined ? null : String(call.sessionId));
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
		 * Nothing to do at a turn boundary any more.
		 *
		 * The pool used to be destroyed here when nothing was queued, on the theory
		 * that a finished conversation had nothing left to serve. But a finished
		 * conversation is often just a pause — the next question repeats the same
		 * history, so the members would have been reused verbatim — and they are
		 * already in flight by now. The hold timer owns their lifetime instead, and it
		 * measures idleness: it restarts on every advance, so a member expires only
		 * after `prewarmHoldMs` with nothing happening. Nothing reconnects while a
		 * conversation sits idle either, because members are opened by a captured
		 * request and by nothing else.
		 */
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
							scheduleSave(scope.sessionId);
						}
						return result;
					},
					return: (value) => {
						note(() => timing.finish(record, performance.now()));
						scheduleSave(scope.sessionId);
						return typeof iterator.return === "function" ? scoped(() => iterator.return(value)) : Promise.resolve({ done: true, value });
					},
					throw: (error) => {
						note(() => timing.finish(record, performance.now(), "error"));
						// The pool is deliberately left alone: a failed step is often
						// retried with the same history, and the next capture advances
						// the members anyway. The row, though, is worth persisting.
						scheduleSave(scope.sessionId);
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
	/** The version this installation is running, read from its own manifest. */
	const readLocalVersion = async () => {
		try {
			return versionFromPackage(await readFile(join(PLUGIN_ROOT, "package.json"), "utf8"));
		} catch {
			return undefined;
		}
	};

	/** Where this plugin was installed from, taken from its own manifest. */
	const readOrigin = async () => {
		try {
			const parsed = JSON.parse(await readFile(join(PLUGIN_ROOT, "package.json"), "utf8"));
			const url = typeof parsed?.repository === "string" ? parsed.repository : parsed?.repository?.url;
			if (typeof url !== "string") return undefined;
			// git+https://github.com/o/r.git → https://raw.githubusercontent.com/o/r/main
			const match = /github\.com[/:]([^/]+)\/([^/.]+)/u.exec(url);
			return match === null ? undefined : `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main`;
		} catch {
			return undefined;
		}
	};

	/** The version the origin publishes, or `undefined` when it cannot be read. */
	const readPublishedVersion = async () => {
		const origin = await readOrigin();
		if (origin === undefined) return undefined;
		try {
			const response = await realFetch(`${origin}/package.json`, { signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS) });
			if (!response.ok) return undefined;
			return versionFromPackage(await response.text());
		} catch {
			return undefined;
		}
	};

	/** Fast-forward this checkout, the way the installer's own pull would. */
	const pullUpdate = () => new Promise((resolve) => {
		execFile("git", ["pull", "--ff-only"], { cwd: PLUGIN_ROOT, timeout: UPDATE_PULL_TIMEOUT_MS }, (error, stdout, stderr) => {
			resolve({ ok: error === null, output: `${stdout ?? ""}${stderr ?? ""}`.trim() });
		});
	});

	ctx.inject(["connection"], (connectionCtx) => {
		connectionCtx.connection.fetch.register({
			path: ENDPOINTS_PATH,
			methods: ["GET"],
			requestBody: "buffered",
			// Only what was observed: a refusal that was recorded, and how many
			// consecutive failures an endpoint has answered. Nothing here is a probe.
			fetch: async () => Response.json({
				endpoints: Object.fromEntries([...new Set([...brotliRefused, ...prewarmBlocked, ...endpointFailures.keys()])].map((url) => [url, {
					brotliRefused: brotliRefused.has(url),
					prewarmBlocked: prewarmBlocked.has(url),
					failures: endpointFailures.get(url) ?? 0
				}]))
			})
		});
		connectionCtx.connection.fetch.register({
			path: VERSION_PATH,
			methods: ["GET", "POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				const action = new URL(request.url).searchParams.get("action") ?? "status";
				if (request.method === "GET") {
					const version = await readLocalVersion();
					const latest = await readPublishedVersion();
					return Response.json({
						version: version ?? null,
						latest: latest ?? null,
						// Only three-part versions on both sides can be compared, and
						// anything unreadable is reported as-is rather than guessed at.
						updateAvailable: version !== undefined && latest !== undefined && isNewer(version, latest)
					});
				}
				if (action !== "update") return Response.json({ error: "unknown action" }, { status: 400 });
				const from = await readLocalVersion();
				const result = await pullUpdate();
				const to = await readLocalVersion();
				ctx.logger?.info?.(`model-request-accelerator: update ${result.ok ? "pulled" : "failed"} ${from ?? "?"} -> ${to ?? "?"}`);
				return Response.json({ ok: result.ok, from: from ?? null, to: to ?? null, output: result.output });
			}
		});
	});

	ctx.inject(["connection"], (connectionCtx) => {
		connectionCtx.connection.fetch.register({
			path: TIMINGS_PATH,
			methods: ["GET"],
			requestBody: "buffered",
			fetch: async (request) => {
				const sessionId = new URL(request.url).searchParams.get("sessionId");
				// Nothing known about this session yet, so it may have history on disk.
				// A store that will not read must not turn the panel into an error —
				// this is the panel for a session that has simply not run anything yet,
				// which is the most ordinary state there is.
				if (ledger !== undefined && !consulted.has(sessionId)) {
					consulted.add(sessionId);
					try {
						timing.seed(sessionId, ledger.read(sessionId));
					} catch (error) {
						ledger = undefined;
						ctx.logger?.warn?.("model-request-accelerator: the durable timing store could not be read; showing only this run");
						ctx.logger?.warn?.(error);
					}
				}
				return Response.json({ measurements: timing.snapshot(sessionId) });
			}
		});
	});

	/** The original transport, captured before this plugin replaces it. */
	const realFetch = globalThis.fetch;

	/**
	 * Put the fixed fields after `messages`, for a provider that pre-transmits.
	 *
	 * Idempotent — a body already in that order is left alone — and refused
	 * whenever the reorder cannot be proven byte-safe. It has to be applied to the
	 * *incoming* body before anything compares it with a held member, because the
	 * member already carries bytes in this order; without that, no claim would ever
	 * match, and the reorder would quietly do nothing at all.
	 *
	 * @param url - the request URL.
	 * @param provider - the attributed provider, when there is one.
	 * @param init - the `fetch` init whose body may be reordered.
	 * @returns the rewritten init and the body it replaced, or `undefined`.
	 */
	const canonicalInit = (url, provider, init) => {
		if (init === null || typeof init !== "object" || typeof init.body !== "string") return undefined;
		const policy = resolvePolicy({ url, provider, policies: state.policies, byEndpoint: state.byEndpoint });
		if (policy?.prewarm !== true || reorderRefused.has(url)) return undefined;
		const canonical = moveMessagesLast(init.body);
		return canonical === undefined ? undefined : { init: { ...init, body: canonical }, original: init.body };
	};

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
	const planRequest = (input, init, options = {}) => {
		if (init === null || typeof init !== "object") return undefined;
		if (typeof input !== "string" && !(input instanceof URL)) return undefined;
		const url = typeof input === "string" ? input : input.href;
		const store = attribution.getStore();
		const record = store?.record;
		const measured = record !== undefined && record !== null && typeof init.body === "string";
		// Recorded after the compression below, so the preparation phase includes
		// it instead of quietly charging it to the upload.
		// Remember what this request looked like, so the next one for the same
		// conversation can have its shared history put on the wire early.
		const isModelBody = typeof init.body === "string";
		const headers = init.headers;
		if (readHeader(headers, CONTENT_ENCODING) !== undefined) return undefined;
		// A signed body cannot be rewritten: compressing it invalidates the signature,
		// and the failure that follows is an authorization error, which is not a shape
		// rejection and so would never fall back. AWS-style signing is recognised by
		// the header that carries the body's own hash.
		if (readHeader(headers, "x-amz-content-sha256") !== undefined) return undefined;
		const policy = resolvePolicy({
			url,
			provider: store?.provider,
			policies: state.policies,
			byEndpoint: state.byEndpoint
		});
		// For a provider that pre-transmits, the fixed fields go to the end so the
		// prefix can cover them — done before the capture and the compression, since
		// all three have to be looking at the same bytes.
		const body = init.body;
		const originalBody = options.originalBody;
		if (store !== undefined && store !== null && isModelBody && store.capture === undefined) {
			store.capture = { body, headers: plainHeaders(headers), url, encoding: undefined };
		}
		// Prefer brotli, but only where it can actually be used: the runtime must
		// have it, and this endpoint must not have already refused it.
		const preferred = policy?.encoding === "gzip" ? "gzip" : BROTLI_AVAILABLE && !brotliRefused.has(url) ? "br" : "gzip";
		const plan = options.compress === false ? undefined : planCompression({
			body,
			policy: policy === undefined ? undefined : { ...policy, encoding: preferred },
			hasContentEncoding: undefined,
			byteLength: (text) => Buffer.byteLength(text, "utf8"),
			encode: (text, encoding) => encodeBody(text, encoding)
		});
		if (isModelBody && store?.capture !== undefined && store.capture.body === body) {
			// A claimed request deliberately skips compressing the body — the member
			// already carries compressed bytes — but the members opened from *its*
			// capture still have to be compressed, so the preference is recorded
			// rather than left as "this request had no plan".
			store.capture.encoding = plan !== undefined ? plan.encoding : options.compress === false ? preferred : undefined;
		}
		if (measured) timing.noteFetch(record, url, Buffer.byteLength(body, "utf8"));
		// A reordered body is itself a rewrite worth making, even when there is
		// nothing to compress.
		if (plan === undefined && originalBody === undefined) return undefined;
		if (plan !== undefined && measured) timing.noteSent(record, plan.compressedBytes, plan.encoding);
		return {
			...(plan ?? {}),
			encoding: plan === undefined ? undefined : plan.encoding,
			reordered: originalBody !== undefined,
			originalBody,
			provider: store?.provider,
			url,
			request: { input, init },
			init: {
				...init,
				...(plan === undefined ? {} : { headers: withEncodingHeader(headers, plan.encoding) }),
				body: plan === undefined ? body : plan.body
			}
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
			const incoming = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
			// Reordered once, here, before anything reads the body: a held member's
			// bytes are already canonical, so the body compared with them has to be
			// too — and the fact that it happened has to outlive this call, or the
			// fallback below could not tell that this request was reordered at all.
			const canonical = incoming === undefined ? undefined : canonicalInit(incoming, scope?.provider, init);
			if (canonical !== undefined) init = canonical.init;
			if (scope !== undefined && scope.prewarm === true) {
				const claimed = await claimPrewarm(scope, input, init);
				if (claimed !== undefined) {
					// Record the request first: the measurement must be anchored at the
					// moment it is issued — the claim — and not after its response has
					// already arrived, or every phase would come out negative.
					planRequest(input, init, { compress: false, originalBody: canonical?.original });
					const response = await completePrewarm(claimed, init, scope);
					if (response !== undefined) {
						// Served from a held member, so nothing was sent — but the pool
						// still has to be brought up to date for the step after.
						if (scope.capture !== undefined) syncPrewarm(scope, scope.capture).catch(() => {});
						return response;
					}
				}
			}
			planned = planRequest(input, init, { originalBody: canonical?.original });
			if (scope !== undefined && scope.prewarmMiss !== undefined && scope.record !== undefined && scope.record !== null) {
				timing.notePrewarmMiss(scope.record, scope.prewarmMiss, scope.prewarmMissDetail);
			}
			// The shared history this request carries is exactly the history the next
			// one will repeat, and it is known the moment this request goes out — so
			// the next request is opened now and the upload overlaps the model call
			// itself, not just the tools that follow it.
			if (scope !== undefined && scope.prewarm === true && scope.capture !== undefined) {
				syncPrewarm(scope, scope.capture).catch(() => {});
			}
		} catch (error) {
			ctx.logger?.warn?.("model-request-accelerator: skipped compression after an error; sending the request uncompressed");
			ctx.logger?.warn?.(error);
			planned = undefined;
		}
		if (planned === undefined) return realFetch.call(this, input, init);
		if (planned.encoding !== undefined) ctx.logger?.info?.(`model-request-accelerator: ${planned.provider ?? "endpoint-matched"} request compressed with ${planned.encoding} ${planned.originalBytes} -> ${planned.compressedBytes} bytes`);
		const response = await realFetch.call(this, input, planned.init);
		// A relay that matches on the body's shape rejects the reordered body. Send
		// the original — exactly once — and leave that endpoint's field order alone.
		if (planned.reordered === true && (response.status === 400 || response.status === 422)) {
			reorderRefused.add(planned.url);
			// Held members carry the reordered bytes, so they can never serve a
			// request that must keep its own order. Other conversations recover on
			// their next request, which will find no member it can continue.
			for (const key of [...prewarms.keys()]) dropPool(key);
			ctx.logger?.warn?.(`model-request-accelerator: ${planned.url} rejected a request with messages last; leaving its field order alone`);
			ctx.logger?.warn?.("model-request-accelerator: released the pools built in that order");
			try {
				await response.body?.cancel?.();
			} catch {}
			return realFetch.call(this, input, {
				...init,
				...(planned.encoding === undefined ? {} : { headers: withEncodingHeader(init.headers, planned.encoding) }),
				body: planned.encoding === undefined ? planned.originalBody : encodeBody(planned.originalBody, planned.encoding)
			});
		}
		if (planned.encoding !== "br" || !isShapeRejection(response.status)) return response;

		// The endpoint would not take the brotli body. Retry the same request as
		// gzip so the adapter never sees a failure it would not have seen
		// uncompressed, and remember the endpoint so this happens once.
		const url = planned.url ?? (typeof input === "string" ? input : input instanceof URL ? input.href : undefined);
		if (url !== undefined) brotliRefused.add(url);
		ctx.logger?.warn?.(`model-request-accelerator: ${url} answered ${response.status} to a brotli body; using gzip for it from now on`);
		try {
			await response.body?.cancel?.();
		} catch {}
		const gzipPlan = planCompression({
			body: planned.original,
			policy: { enabled: true, minBytes: 0, prewarm: false, encoding: "gzip" },
			hasContentEncoding: undefined,
			byteLength: (text) => Buffer.byteLength(text, "utf8"),
			encode: (text, encoding) => encodeBody(text, encoding)
		});
		if (gzipPlan === undefined) return realFetch.call(this, input, init);
		const record = attribution.getStore()?.record;
		if (record !== undefined && record !== null) timing.noteSent(record, gzipPlan.compressedBytes, "gzip");
		return realFetch.call(this, input, { ...init, headers: withEncodingHeader(init.headers, "gzip"), body: gzipPlan.body });
	};

	ctx.effect(() => {
		globalThis.fetch = patchedFetch;
		return () => {
			if (globalThis.fetch === patchedFetch) globalThis.fetch = realFetch;
		};
	});
}
