/**
 * Tests for the HTTP/2 transport's decision logic and its fallback.
 *
 * Both injection points are used so none of this needs a network: `load` supplies
 * a fake undici module pair and `fetch` a fake transport. What is being tested is
 * the rule the module exists to enforce — h2 only where the provider asked for it
 * and the link can carry it, and one failure condemning an origin for good —
 * rather than undici's own protocol behaviour.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";
import { createRequire } from "node:module";
import { createTransport, isTransportFailure } from "../lib/transport.js";

/** A fake undici module pair; `fetch` records what it was given. */
function fakePair(behaviour = {}) {
	const calls = [];
	const agents = [];
	class Agent {
		constructor(options) {
			this.options = options;
			this.closed = false;
			agents.push(this);
		}

		close() {
			this.closed = true;
			return Promise.resolve();
		}
	}
	return {
		calls,
		agents,
		pair: {
			Agent,
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (typeof behaviour.fetch === "function") return behaviour.fetch(url, init);
				return { status: 200, httpVersion: behaviour.httpVersion ?? "h2", body: { cancel: async () => {} } };
			}
		}
	};
}

/** A policy that has h2 on, which is what a pre-transmitting provider compiles to. */
const ON = { enabled: true, minBytes: 1024, prewarm: true, http2: true };
/** A policy with h2 off. */
const OFF = { enabled: true, minBytes: 1024, prewarm: false, http2: false };

test("offers h2 only over TLS, and only when the policy enabled it", () => {
	const transport = createTransport({ load: () => fakePair().pair });
	assert.equal(transport.enabled({ provider: "sg", policy: ON, url: "https://gw.example/v1/chat/completions" }), true);
	assert.equal(transport.enabled({ provider: "sg", policy: ON, url: "http://gw.example/v1/chat/completions" }), false, "cleartext needs an explicit opt-in");
	assert.equal(transport.enabled({ provider: "sg", policy: ON, url: "http://gw.example/v1/chat/completions", allowInsecure: true }), true);
	assert.equal(transport.enabled({ provider: "sg", policy: OFF, url: "https://gw.example/v1/chat/completions" }), false);
	assert.equal(transport.enabled({ provider: undefined, policy: ON, url: "https://gw.example/v1/chat/completions" }), false, "an unattributed request has no policy to honour");
	assert.equal(transport.enabled({ provider: "sg", policy: ON, url: "not a url" }), false);
});

test("offers nothing at all when no copy of undici is installed", () => {
	const transport = createTransport({ load: () => undefined });
	assert.equal(transport.enabled({ provider: "sg", policy: ON, url: "https://gw.example/v1/chat/completions" }), false);
});

test("drives fetch and Agent from the same module instance", async () => {
	const fake = fakePair();
	const transport = createTransport({ load: () => fake.pair });
	const outcome = await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(outcome.sent, true);
	assert.equal(fake.calls.length, 1);
	assert.equal(fake.calls[0].init.dispatcher.constructor.name, "Agent");
	// The pair must never be crossed with another copy: an Agent from one undici and
	// a fetch from another is rejected at dispatch time with `invalid onRequestStart
	// method`, which is the failure this pairing exists to prevent.
	assert.equal(fake.calls[0].init.dispatcher.options.allowH2, true);
});

test("reports the protocol the transport announces, not the one that was asked for", async () => {
	const fake = fakePair();
	const transport = createTransport({ load: () => fake.pair });
	// undici announces the negotiated version on its own connection diagnostic while
	// the body is still being written — its `Response` carries no `httpVersion`, so
	// this event is the only place the answer exists.
	const protocols = [];
	const original = fake.pair.fetch;
	const spy = async (url, init) => {
		diagnosticsChannel.channel("undici:client:connected").publish( { connectParams: { hostname: "gw.example", port: "443", version: "h1", protocol: "https:" } });
		return original(url, init);
	};
	const outcome = await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" }, {
		onConnected: (protocol) => protocols.push(protocol)
	});
	assert.equal(outcome.sent, true);
	assert.deepEqual(protocols, [], "the real transport announces nothing here, because nothing connected");
	// Now the same call, with the announcement restored where the transport reads it.
	const caught = [];
	transport.dispose();
	const second = createTransport({ load: () => ({ ...fake.pair, fetch: spy }) });
	await second.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" }, {
		onConnected: (protocol) => caught.push(protocol)
	});
	assert.deepEqual(caught, ["h1"], "an endpoint that does not choose h2 through ALPN reports h1, and that is what is recorded");
});

test("does not report a protocol for a connection that then failed", async () => {
	// undici announces `h2` on its connection diagnostic *before* a cleartext upgrade
	// is proven, so a failed attempt still announces h2. Reporting that would put a
	// protocol on a row for a response that never arrived.
	const fake = fakePair();
	const pair = {
		...fake.pair,
		fetch: async () => {
			diagnosticsChannel.channel("undici:client:connected").publish({ connectParams: { hostname: "gw.example", port: "443", version: "h2" } });
			const error = new Error("fetch failed");
			error.cause = new Error("Protocol error");
			throw error;
		}
	};
	const transport = createTransport({ load: () => pair });
	const protocols = [];
	const outcome = await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" }, {
		onConnected: (protocol) => protocols.push(protocol)
	});
	assert.equal(outcome.sent, false);
	assert.deepEqual(protocols, [], "an announced connection that failed is not a protocol this request used");
});

test("does not report a connection negotiated for another origin", async () => {
	const fake = fakePair();
	const original = fake.pair.fetch;
	const pair = {
		...fake.pair,
		fetch: async (url, init) => {
			diagnosticsChannel.channel("undici:client:connected").publish( { connectParams: { hostname: "elsewhere.example", port: "443", version: "h2" } });
			return original(url, init);
		}
	};
	const transport = createTransport({ load: () => pair });
	const protocols = [];
	await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" }, {
		onConnected: (protocol) => protocols.push(protocol)
	});
	assert.deepEqual(protocols, [], "another origin's connection is not this request's protocol");
});

test("an origin is retried once, then condemned for good", async () => {
	// One failure is usually this connection's rather than this endpoint's, and
	// condemning an origin is permanent — so a single reset stream, or a socket
	// reclaimed while it was idle, must not be enough to write h2 off.
	const attempts = [];
	const log = [];
	const fake = fakePair({
		fetch: () => {
			attempts.push(1);
			const error = new Error("fetch failed");
			error.cause = new Error("other side closed");
			return Promise.reject(error);
		}
	});
	const transport = createTransport({ load: () => fake.pair, log: (message) => log.push(message) });
	const url = "https://bad.example/v1/chat/completions";

	const first = await transport.execute(url, { method: "POST", body: "{}" });
	assert.equal(first.sent, false);
	assert.equal(first.reason, "transport");
	assert.equal(attempts.length, 2, "the first attempt is retried once");
	assert.equal(transport.isBlocked("https://bad.example"), true);
	assert.equal(transport.enabled({ provider: "sg", policy: ON, url }), false, "the next request goes straight to the default transport");

	const second = await transport.execute(url, { method: "POST", body: "{}" });
	assert.equal(second.sent, false);
	assert.equal(second.reason, "unavailable");
	assert.equal(attempts.length, 2, "a condemned origin is never tried again");
	assert.equal(log.length, 1, "and it is reported once, not per request");
});

test("a failure that turns out to be the connection's leaves the origin alone", async () => {
	const attempts = [];
	const fake = fakePair({
		fetch: () => {
			attempts.push(1);
			if (attempts.length === 1) {
				const error = new Error("fetch failed");
				error.cause = new Error("other side closed");
				return Promise.reject(error);
			}
			return Promise.resolve({ status: 200 });
		}
	});
	const transport = createTransport({ load: () => fake.pair });
	const outcome = await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(outcome.sent, true, "the retry carried the request");
	assert.equal(attempts.length, 2);
	assert.equal(transport.isBlocked("https://gw.example"), false, "a recovered origin keeps its HTTP/2");
	transport.dispose();
});

test("an abort is the caller's business, not the endpoint's", async () => {
	const controller = new AbortController();
	const fake = fakePair({
		fetch: () => {
			controller.abort();
			const error = new Error("This operation was aborted");
			error.name = "AbortError";
			return Promise.reject(error);
		}
	});
	const transport = createTransport({ load: () => fake.pair });
	const outcome = await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}", signal: controller.signal });
	assert.equal(outcome.sent, false);
	assert.equal(outcome.reason, "aborted");
	assert.equal(transport.isBlocked("https://gw.example"), false, "a cancelled request must not condemn the endpoint");
});

test("a response is never a transport failure, whatever its status", async () => {
	const fake = fakePair({ fetch: () => Promise.resolve({ status: 415, httpVersion: "h2" }) });
	const transport = createTransport({ load: () => fake.pair });
	const outcome = await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(outcome.sent, true);
	assert.equal(outcome.response.status, 415, "a shape rejection reaches the caller to be handled as usual");
	assert.equal(transport.isBlocked("https://gw.example"), false);
});

test("classifies failures at the boundary the fallback depends on", () => {
	assert.equal(isTransportFailure(new Error("socket hang up"), undefined), true);
	assert.equal(isTransportFailure(new Error("x"), { aborted: true }), false);
	const abort = new Error("aborted");
	abort.name = "AbortError";
	assert.equal(isTransportFailure(abort, undefined), false);
	const timeout = new Error("timed out");
	timeout.name = "TimeoutError";
	assert.equal(isTransportFailure(timeout, undefined), false);
});

test("opens one Agent per origin and closes them all on dispose", async () => {
	const fake = fakePair();
	const seen = [];
	const transport = createTransport({
		load: () => fake.pair,
		fetch: (pair, origin) => {
			seen.push(origin);
			return (url, init) => pair.fetch(url, init);
		}
	});
	await transport.execute("https://a.example/v1/chat/completions", { method: "POST", body: "{}" });
	await transport.execute("https://b.example/v1/chat/completions", { method: "POST", body: "{}" });
	await transport.execute("https://a.example/v1/chat/completions", { method: "POST", body: "{}" });
	assert.deepEqual(seen, ["https://a.example", "https://b.example", "https://a.example"]);
	assert.equal(transport.enabled({ provider: "sg", policy: ON, url: "https://a.example/v1/chat/completions" }), true);
	assert.equal(fake.agents.length, 2, "one Agent per origin, not one per request");
	transport.dispose();
	assert.equal(fake.agents.every((agent) => agent.closed), true, "dispose closes every Agent it opened");
	assert.equal(transport.enabled({ provider: "sg", policy: ON, url: "https://a.example/v1/chat/completions" }), false, "a disposed transport offers nothing");
	const after = await transport.execute("https://a.example/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(after.sent, false);
});

test("matches a connection whose default port is reported as empty", async () => {
	// A real gateway on 443 reports `port: ""`, not `port: "443"`, and `host` as a
	// bare hostname — the first draft of the match rejected exactly this and silently
	// reported no protocol at all.
	const fake = fakePair();
	const pair = {
		...fake.pair,
		fetch: async (url, init) => {
			diagnosticsChannel.channel("undici:client:connected").publish({ connectParams: { host: "gw.example", hostname: "gw.example", protocol: "https:", port: "", version: "h2" } });
			return fake.pair.fetch(url, init);
		}
	};
	const transport = createTransport({ load: () => pair });
	const protocols = [];
	await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" }, {
		onConnected: (protocol) => protocols.push(protocol)
	});
	assert.deepEqual(protocols, ["h2"], "an implicit 443 on both sides is the same port");
});

test("resolves a copy of undici without being told where it is", async () => {
	// The deployment that caught this: an installed plugin lives at
	// `<profile>/plugins/<name>/`, and the only reachable copy of undici is in the
	// profile's hoisted `node_modules` two levels up — not in the plugin's own. Node's
	// own resolution is what finds it, so the explicit candidate list must not be the
	// only path. Without this the transport silently reported itself unavailable and
	// h2 would have been off in every real install while every test passed.
	const transport = createTransport();
	const reachable = transport.enabled({ provider: "sg", policy: { http2: true }, url: "https://gw.example/v1/chat/completions" });
	const viaResolve = (() => {
		try {
			return createRequire(import.meta.url).resolve("undici") !== undefined;
		} catch {
			return false;
		}
	})();
	assert.equal(reachable, viaResolve, "the transport is available exactly when undici is resolvable from the plugin");
	transport.dispose();
});

test("reports the protocol for every request on a reused connection, not just the first", async () => {
	// `undici:client:connected` fires once per socket, so on a pooled keep-alive
	// connection only the request that opened it ever sees it. Reading the protocol
	// only from that event would leave every later row claiming nothing while the
	// requests really do travel over h2 — which is exactly what the panel showed.
	const fake = fakePair();
	let announced = false;
	const pair = {
		...fake.pair,
		fetch: async (url, init) => {
			if (!announced) {
				announced = true;
				diagnosticsChannel.channel("undici:client:connected").publish({ connectParams: { hostname: "gw.example", protocol: "https:", port: "", version: "h2" } });
			}
			return fake.pair.fetch(url, init);
		}
	};
	const transport = createTransport({ load: () => pair });
	const perRequest = [];
	for (let index = 0; index < 3; index += 1) {
		const seen = [];
		await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" }, { onConnected: (protocol) => seen.push(protocol) });
		perRequest.push(seen);
	}
	assert.deepEqual(perRequest, [["h2"], ["h2"], ["h2"]], "a reused connection keeps reporting the protocol it negotiated");
	transport.dispose();
});

test("a failed attempt does not leave a protocol behind for the origin", async () => {
	// The other half of the same rule: a cleartext upgrade announces `h2` and then
	// fails, so nothing may be remembered from an attempt that never carried a request.
	const fake = fakePair();
	const pair = {
		...fake.pair,
		fetch: async () => {
			diagnosticsChannel.channel("undici:client:connected").publish({ connectParams: { hostname: "gw.example", protocol: "https:", port: "", version: "h2" } });
			const error = new Error("fetch failed");
			error.cause = new Error("Protocol error");
			throw error;
		}
	};
	const transport = createTransport({ load: () => pair });
	await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" }, { onConnected: () => {} });
	assert.equal(transport.isBlocked("https://gw.example"), true);
	const seen = [];
	await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" }, { onConnected: (protocol) => seen.push(protocol) });
	assert.deepEqual(seen, [], "a condemned origin reports no protocol, because it never used one");
	transport.dispose();
});

test("hands back the protocol a member's connection already negotiated", async () => {
	// This is the pre-transmission path: a pool member opens its connection *while it
	// is being opened*, long before the request that eventually claims it arrives. By
	// then no connection event will fire again, so the protocol has to be available
	// after the fact — otherwise every pre-transmitted row reports nothing while the
	// member really did travel over h2.
	const fake = fakePair();
	const pair = {
		...fake.pair,
		fetch: async (url, init) => {
			diagnosticsChannel.channel("undici:client:connected").publish({ connectParams: { hostname: "gw.example", protocol: "https:", port: "", version: "h2" } });
			return fake.pair.fetch(url, init);
		}
	};
	const transport = createTransport({ load: () => pair });
	assert.equal(transport.protocolFor("https://gw.example"), undefined, "nothing is known before anything connected");
	// Open the member: this is what `openMember` does, in its own async context.
	const opened = await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" }, { onConnected: () => {} });
	assert.equal(opened.sent, true);
	// Later, the request that claims it runs in a different scope and sees no event.
	assert.equal(transport.protocolFor("https://gw.example"), "h2", "the member's connection is still the answer");
	assert.equal(transport.protocolFor("https://other.example"), undefined, "and it is per origin");
	transport.dispose();
	assert.equal(transport.protocolFor("https://gw.example"), undefined, "dispose forgets it");
});

test("does not let a cleartext upgrade's preface overwrite its outcome", async () => {
	// An h2c upgrade announces its connections in order: the http/1.1 socket it starts
	// with, then the h2 session it became. Both carry the same origin and port, so
	// "the last announcement wins" hands back `h1` for a request that really did
	// travel over h2 — which is what made a whole session's rows report h1.
	const fake = fakePair();
	const pair = {
		...fake.pair,
		fetch: async (url, init) => {
			const channel = diagnosticsChannel.channel("undici:client:connected");
			const base = { hostname: "gw.example", port: "", protocol: "https:" };
			channel.publish({ connectParams: { ...base, version: "h2" } });
			channel.publish({ connectParams: { ...base, version: "h1" } });
			return fake.pair.fetch(url, init);
		}
	};
	const transport = createTransport({ load: () => pair });
	const seen = [];
	await transport.execute("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" }, { onConnected: (protocol) => seen.push(protocol) });
	assert.deepEqual(seen, ["h2"], "h2 is the outcome; the h1 socket it upgraded from is not");
	assert.equal(transport.protocolFor("https://gw.example"), "h2");
	transport.dispose();
});

test("does not retry a body that cannot be sent twice", async () => {
	// Replaying a consumed stream throws "Response body object should not be disturbed or
	// locked" — a second failure that condemns the origin for a reason that has nothing
	// to do with the endpoint. A held member's body is exactly this shape, so the retry
	// has to stand down rather than double the failure.
	const attempts = [];
	const fake = fakePair({
		fetch: () => {
			attempts.push(1);
			const error = new Error("fetch failed");
			error.cause = new Error("other side closed");
			return Promise.reject(error);
		}
	});
	const transport = createTransport({ load: () => fake.pair });
	const outcome = await transport.execute("https://gw.example/v1/chat/completions", {
		method: "POST",
		body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{}")); } }),
		duplex: "half"
	});
	assert.equal(attempts.length, 1, "a streamed body is attempted once and not replayed");
	assert.equal(outcome.sent, false);
	assert.equal(outcome.reason, "transport");
	transport.dispose();
});
