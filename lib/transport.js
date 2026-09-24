/**
 * HTTP/2 transport for model requests, with a fallback that cannot be worse than
 * not having it.
 *
 * Node's `globalThis.fetch` speaks HTTP/1.1 only. Its dispatcher is the built-in
 * undici's own `Agent`, which does not pass `allowH2` — and undici upgrades to
 * h2 only when that option is *explicitly* true — while the built-in Agent class
 * is not reachable from application code (`process.getBuiltinModule` does not
 * resolve node's internal undici, and the internal specifier is not a public
 * builtin). So there is no way to ask the built-in transport for h2.
 *
 * What does work is a *consistent pair*: dsh's own `undici` package, driving its
 * own `fetch` with its own `Agent({ allowH2: true })`. Mixing the two undici
 * instances in either direction does not: the bundled 7.x fetch rejects an 8.x
 * Agent's handler with `invalid onRequestStart method`. Hence the rule this
 * module exists to enforce — **both halves always come from the same module
 * instance**, and if only one is resolvable, h2 is simply off.
 *
 * Degradation is the protocol's own, not a retry state machine: h2 is reached
 * through ALPN, so an origin that does not offer it stays on http/1.1 inside the
 * same Agent, with no error and nothing to detect. What is left for this module
 * is the case ALPN cannot cover — a transport that fails outright, or an
 * `http://` origin, where h2 would need cleartext h2c — so an origin that has
 * failed once is remembered and never tried again for the life of the plugin.
 *
 * @module dsh-plugin-model-request-accelerator/transport
 */

import { createRequire } from "node:module";
import diagnosticsChannel from "node:diagnostics_channel";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This file lives in the package's `lib/`. */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * undici's report of a connection that has just been established, carrying the
 * protocol that won ALPN. It is the only place the negotiated version is exposed:
 * undici's `Response` has no `httpVersion`, so the answer cannot be read off the
 * response and has to be taken from the transport's own event.
 */
const CONNECTED_CHANNEL = "undici:client:connected";

/**
 * The orders in which a copy of undici is looked for.
 *
 * Node's own resolution comes first, because that is the one that works in the
 * layout this plugin actually runs in: an installed plugin lives at
 * `<profile>/plugins/<name>/`, and Node walks up from there into the profile's
 * hoisted `node_modules`, where dsh's own dependency tree already put undici —
 * and where the plugin's *imports* resolve from, so a copy found any other way
 * could be a different instance than the one the rest of the plugin sees.
 * The explicit candidates are a fallback for a deployment that installed its
 * dependencies differently.
 */
const UNDICI_CANDIDATES = [
	undefined,
	join(PLUGIN_ROOT, "node_modules", "undici"),
	join(PLUGIN_ROOT, "..", "..", "node_modules", "undici"),
	join(PLUGIN_ROOT, "..", "node_modules", "undici")
];

/**
 * Load one module instance of undici — the `fetch` and the `Agent` must come
 * from this same object, or the pair is rejected at dispatch time.
 * @returns `{ fetch, Agent }`, or `undefined` when no usable copy is installed.
 */
function loadUndici() {
	const require = createRequire(import.meta.url);
	for (const candidate of UNDICI_CANDIDATES) {
		try {
			// `require.resolve` for the bare specifier, so the profile's hoisted tree is
			// searched the way Node searches it; a bare directory for the explicit ones.
			const specifier = candidate === undefined ? "undici" : join(candidate, "index.js");
			const loaded = require(require.resolve(specifier));
			if (typeof loaded?.fetch === "function" && typeof loaded?.Agent === "function") {
				return { fetch: loaded.fetch, Agent: loaded.Agent };
			}
		} catch {}
	}
	return undefined;
}

/**
 * Whether a failure means "this origin cannot do h2 here" rather than "this
 * request failed".
 *
 * An HTTP status is not a transport failure — the request arrived and was
 * answered — and an abort is the caller's own decision. Everything else
 * (connection reset, protocol error, TLS negotiation, a body that died
 * mid-upload) is indistinguishable from an h2 problem at this distance, so it is
 * treated as one: one wasted retry, and that origin is done with h2 for good.
 * @param error - whatever `fetch` rejected with.
 * @param signal - the caller's abort signal, when it supplied one.
 * @returns whether to fall back and condemn the origin.
 */
export function isTransportFailure(error, signal) {
	if (signal?.aborted === true) return false;
	const name = error?.name;
	if (name === "AbortError" || name === "TimeoutError") return false;
	return true;
}

/**
 * Build the h2 transport for one plugin instance.
 *
 * @param options - injection points, so the decision logic is testable without a
 *   network: `load` supplies the module pair, `fetch` the transport.
 * @param options.log - warning sink.
 * @param options.load - returns `{ fetch, Agent }`, defaulting to the real loader.
 * @param options.fetch - returns the transport for an origin, defaulting to the
 *   loaded module's own `fetch`.
 * @returns the transport.
 */
export function createTransport(options = {}) {
	const log = options.log;
	const load = options.load ?? loadUndici;
	/** The module pair, resolved once, or `null` once it is known to be absent. */
	let module;

	/** `origin -> Agent`, created lazily so an unused origin costs nothing. */
	const agents = new Map();
	/** Origins that failed an h2 attempt, and are never tried again. */
	const blocked = new Set();
	/**
	 * `origin -> the protocol its live connection negotiated`.
	 *
	 * This has to be remembered, because `client:connected` fires **once per socket**:
	 * on a pooled keep-alive connection only the request that opened it ever sees the
	 * diagnostic, so reading the protocol from that event alone leaves every later
	 * request reporting nothing while it really does travel over h2. The value is
	 * cleared whenever an origin's attempt fails, since it is then no longer known
	 * what that origin will do.
	 */
	const negotiated = new Map();
	let disposed = false;

	/** Resolve the module pair once, and only once. */
	const resolveModule = () => {
		if (module === undefined) module = load() ?? null;
		return module ?? undefined;
	};

	/** The transport for one origin, or `undefined` when h2 is not set up. */
	const transportFor = (origin) => {
		if (disposed) return undefined;
		const pair = resolveModule();
		if (pair === undefined) return undefined;
		if (typeof options.fetch === "function") return options.fetch(pair, origin);
		return (url, init) => pair.fetch(url, init);
	};

	/** The Agent for one origin, created on first use. */
	const agentFor = (origin, allowInsecure) => {
		const pair = resolveModule();
		if (pair === undefined) return undefined;
		// A cleartext and a TLS connection to the same origin are different
		// connections, so they cannot share one Agent.
		const key = allowInsecure === true ? `${origin}\u0000h2c` : origin;
		let agent = agents.get(key);
		if (agent === undefined) {
			// `allowH2` is what makes undici offer `h2` in ALPN; an origin that does not
			// choose it simply continues on http/1.1 through this same Agent — no error,
			// nothing to detect. `useH2c` is the cleartext variant, reached with no ALPN
			// and no certificate at all, so it is only added for an origin the
			// deployment explicitly declared trusted.
			agent = new pair.Agent({ allowH2: true, ...(allowInsecure === true ? { useH2c: true } : {}), connections: 1 });
			agents.set(key, agent);
		}
		return agent;
	};

	return {
		/**
		 * Whether h2 should carry this one request. A policy that did not enable it
		 * and an `http://` origin that was not explicitly allowed are both answered
		 * here, so the caller only has to ask.
		 * @param request - provider, policy, URL and the section-wide allowance.
		 * @returns true when the caller should route through `execute`.
		 */
		enabled(request) {
			if (disposed) return false;
			if (resolveModule() === undefined) return false;
			const { provider, policy, url, allowInsecure } = request;
			if (typeof provider !== "string" || provider.length === 0) return false;
			if (policy?.http2 !== true) return false;
			let parsed;
			try {
				parsed = new URL(url);
			} catch {
				return false;
			}
			// h2 is reached through ALPN, which needs TLS. Cleartext h2c is a different
			// mechanism with no certificate behind it, so it is only ever used when the
			// deployment says the link is trusted.
			if (parsed.protocol !== "https:" && !(allowInsecure === true && parsed.protocol === "http:")) return false;
			return !blocked.has(parsed.origin);
		},

		/**
		 * Send one request over h2 and report whether it arrived.
		 *
		 * A thrown error whose cause identifies the origin as the problem condemns
		 * that origin and is reported as "not sent", so the caller can repeat the
		 * request on the built-in transport. Everything else — including every HTTP
		 * status — is returned as a response, exactly like `fetch` would.
		 *
		 * @param input - the `fetch` first argument.
		 * @param init - the rewritten init.
		 * @param options - the abort signal the caller wants honoured, and a
		 *   `onConnected` sink for the protocol the connection negotiated.
		 * @returns the response and whether it was sent, or a reason why not.
		 */
		async execute(input, init, options = {}) {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
			let origin;
			try {
				origin = url === undefined ? undefined : new URL(url).origin;
			} catch {
				origin = undefined;
			}
			const send = origin === undefined || blocked.has(origin) ? undefined : transportFor(origin);
			if (send === undefined) return { sent: false, reason: "unavailable" };
			const agent = agentFor(origin, options.allowInsecure);
			// The caller's abort signal has to reach the transport that actually
			// carries the request; delegating to it avoids a second controller whose
			// timing would differ from the one being measured.
			const signal = options.signal ?? init?.signal ?? undefined;
			// The protocol is reported while the body is still being written, so it is
			// learned rather than returned: it arrives mid-request, and the caller's
			// measurement is the only thing that can still be told about it. It is held
			// until the send is known to have worked, because undici announces the
			// connection *before* the handshake is proven — a cleartext upgrade that the
			// far end refuses reports `h2` and then fails, and a row must not claim a
			// protocol that never carried anything.
			//
			// What is already known about this origin is read *before* the send, so that a
			// value learned during this attempt cannot stand in for the outcome of it.
			const target = origin === undefined ? undefined : new URL(origin);
			const alreadyKnown = origin === undefined ? undefined : negotiated.get(origin);
			let announced;
			const watch = typeof options.onConnected === "function" ? (message) => {
				const connected = message?.connectParams;
				if (connected === undefined) return;
				// undici reports the address it connected to rather than an origin, so the
				// two are compared by host and port. This is a sanity check against
				// attributing some other socket's negotiation to this request; the
				// request-level pairing belongs to the caller.
				const host = connected.hostname ?? connected.host?.split(":")[0];
				if (target !== undefined && host !== undefined && host !== target.hostname) return;
				// A default port is reported as an empty string, not as `443`, so it has to
				// be filled in on both sides or a perfectly good connection is rejected.
				const expectedPort = target === undefined ? undefined : target.port === "" ? (target.protocol === "https:" ? "443" : "80") : target.port;
				const connectedPort = connected.port === undefined || connected.port === ""
					? connected.protocol === "https:" ? "443" : connected.protocol === "http:" ? "80" : undefined
					: String(connected.port);
				if (expectedPort !== undefined && connectedPort !== undefined && connectedPort !== expectedPort) return;
				const version = connected.version === undefined || connected.version === null ? undefined : String(connected.version);
				if (version !== undefined) announced = version;
			} : undefined;
			if (watch !== undefined) diagnosticsChannel.subscribe(CONNECTED_CHANNEL, watch);
			let response;
			try {
				response = await send(url, { ...init, dispatcher: agent, signal });
			} catch (error) {
				if (isTransportFailure(error, signal)) {
					blocked.add(origin);
					negotiated.delete(origin);
					log?.(`model-request-accelerator: ${origin} failed over HTTP/2 (${error?.cause?.message ?? error?.message ?? error}); using the default transport for it from now on`);
					return { sent: false, reason: "transport" };
				}
				return { sent: false, reason: "aborted", error };
			} finally {
				if (watch !== undefined) diagnosticsChannel.unsubscribe(CONNECTED_CHANNEL, watch);
			}
			// A fresh announcement is authoritative for this request; otherwise the
			// connection this request just reused already answered the question.
			const protocol = announced ?? alreadyKnown;
			if (protocol !== undefined) {
				negotiated.set(origin, protocol);
				options.onConnected(protocol);
			}
			return { sent: true, response };
		},

		/** Whether one origin has been condemned already, for the settings route. */
		isBlocked(origin) {
			return blocked.has(origin);
		},

		/** Every origin h2 has been abandoned for, for the settings route. */
		blockedOrigins() {
			return [...blocked];
		},

		/** Release every Agent this plugin opened. */
		dispose() {
			disposed = true;
			for (const agent of agents.values()) {
				try {
					const closing = agent.close?.();
					if (closing !== undefined && typeof closing.catch === "function") closing.catch(() => {});
				} catch {}
			}
			agents.clear();
			blocked.clear();
			negotiated.clear();
		}
	};
}
