/**
 * Integration test for the Host half.
 *
 * Runs the real `apply()` against a minimal fake Cordis context and a spied
 * `globalThis.fetch`, so the whole path under test is production code: schema
 * resolution, the settings hook contract, the `llm/stream` attribution scope,
 * and the fetch rewrite.
 *
 * The fixture deliberately reproduces this deployment's awkward shape — two
 * provider routes (`alpha`, `beta`) sharing one endpoint — because that is the
 * case endpoint-only matching gets wrong.
 *
 * Run: node --test test/
 */

import assert from "node:assert/strict";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { apply, Config, NS } from "../lib/index.js";

/** Two routes, one endpoint: `alpha` is a whole-section profile, `beta` a nested one. */
const SHARED_ENDPOINT = "https://gateway.example/v1";
const OTHER_ENDPOINT = "https://other.example/v1";

/** A configurable-provider directory covering both profile shapes. */
const DIRECTORY = [
	{ provider: "alpha", displayName: "Alpha", settingsNs: "llm-alpha", settingsPath: [] },
	{ provider: "beta", displayName: "Beta", settingsNs: "llm-beta", settingsPath: ["providers", "beta"] }
];

/** Namespace values the plugin reads to learn each route's endpoint. */
const NEIGHBOUR_NAMESPACES = {
	"llm-alpha": { baseURL: SHARED_ENDPOINT },
	"llm-beta": { providers: { beta: { baseURL: SHARED_ENDPOINT } } }
};

/**
 * Build a fake Host context that honours exactly the contracts the plugin uses.
 * @param section - the user section stored for this plugin's namespace.
 * @returns the context, the recorded listeners, and an effect disposer runner.
 */
function createHarness(initialSection = {}) {
	let section = initialSection;
	const listeners = new Map();
	const effects = [];
	const routes = [];
	let install;

	/** The `connection.fetch` face the plugin registers its timing route on. */
	const connection = {
		fetch: {
			register(route) {
				routes.push(route);
				return () => {};
			}
		}
	};

	const settings = {
		installSection(owner, ns, schema, base, hooks) {
			assert.equal(ns, NS);
			install = { schema, base, hooks };
			// Mirrors SettingsProvider.installSection: source, then the first change.
			hooks.setSource(() => schema({ ...base, ...section }));
			hooks.onChange();
		},
		get(ns) {
			if (ns === NS) return install.schema({ ...install.base, ...section });
			return NEIGHBOUR_NAMESPACES[ns];
		}
	};

	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		get(name) {
			if (name === "settings") return settings;
			if (name === "llm") return { listConfigurableProviders: () => DIRECTORY };
			return undefined;
		},
		on(event, listener) {
			const list = listeners.get(event) ?? [];
			list.push(listener);
			listeners.set(event, list);
			return () => {};
		},
		effect(callback) {
			effects.push(callback());
			return () => {};
		},
		inject(names, callback) {
			callback({ settings, connection });
			return () => {};
		}
	};

	/** Replace the stored section and announce it, as a committed write would. */
	const setSection = (next) => {
		section = next;
		install.hooks.onChange();
	};

	return { ctx, listeners, routes, setSection, disposeAll: () => { for (const dispose of effects) dispose(); } };
}

/** Install a spy transport, returning the recorded calls and a restore hook. */
function spyFetch() {
	const calls = [];
	const real = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		calls.push({ url: String(input), init });
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	};
	return { calls, restore: () => { globalThis.fetch = real; } };
}

/** Decode what actually went on the wire for one recorded call. */
function bodyOf(call) {
	const header = call.init.headers["content-encoding"];
	if (header === undefined) return { encoding: "identity", text: call.init.body };
	assert.equal(header, "gzip");
	return { encoding: "gzip", text: gunzipSync(Buffer.from(call.init.body)).toString("utf8") };
}

/**
 * Drive one streaming model call for `provider`, the way the agent loop does:
 * inside the `llm/stream` waterfall, with an `await` before the adapter reaches
 * `fetch` (proving the attribution scope survives suspension points).
 * @param listeners - recorded event listeners.
 * @param provider - the provider route being streamed.
 * @param request - the fetch call the fake adapter performs.
 */
async function streamWithFetch(listeners, provider, request) {
	const waterfall = listeners.get("llm/stream")[0];
	const inner = (async function* adapter() {
		await new Promise((resolve) => setTimeout(resolve, 1));
		await request();
		yield { type: "text-delta", index: 0, text: "ok" };
	})();
	for await (const _chunk of waterfall({ provider }, () => inner)) {
		// Drain the stream exactly as the LLM service would.
	}
}

/** A chat-completions-shaped call, large enough to clear the default threshold. */
function chatRequest(url) {
	return {
		input: `${url}/chat/completions`,
		init: {
			method: "POST",
			headers: { authorization: "Bearer secret", "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(4096) }] })
		}
	};
}

test("compresses only the enabled provider, even when two routes share an endpoint", async () => {
	const harness = createHarness({ providers: { beta: { enabled: true } } });
	const transport = spyFetch();
	try {
		apply(harness.ctx);

		const betaCall = chatRequest(SHARED_ENDPOINT);
		await streamWithFetch(harness.listeners, "beta", () => globalThis.fetch(betaCall.input, betaCall.init));
		const alphaCall = chatRequest(SHARED_ENDPOINT);
		await streamWithFetch(harness.listeners, "alpha", () => globalThis.fetch(alphaCall.input, alphaCall.init));

		assert.equal(transport.calls.length, 2);
		const beta = bodyOf(transport.calls[0]);
		const alpha = bodyOf(transport.calls[1]);

		assert.equal(beta.encoding, "gzip", "the enabled route must be compressed");
		assert.equal(beta.text, betaCall.init.body, "compression must preserve the exact JSON body");
		assert.equal(alpha.encoding, "identity", "a disabled route on the same endpoint must stay uncompressed");
		assert.equal(alpha.text, alphaCall.init.body);
	} finally {
		transport.restore();
		harness.disposeAll();
	}
});

test("keeps required headers and drops the stale content-length", async () => {
	const harness = createHarness({ providers: { beta: { enabled: true } } });
	const transport = spyFetch();
	try {
		apply(harness.ctx);
		const call = chatRequest(SHARED_ENDPOINT);
		call.init.headers["content-length"] = String(Buffer.byteLength(call.init.body));
		await streamWithFetch(harness.listeners, "beta", () => globalThis.fetch(call.input, call.init));

		const headers = transport.calls[0].init.headers;
		assert.equal(headers.authorization, "Bearer secret");
		assert.equal(headers["content-type"], "application/json");
		assert.equal(headers["content-encoding"], "gzip");
		assert.equal(headers["content-length"], undefined, "content-length would describe the uncompressed body");
	} finally {
		transport.restore();
		harness.disposeAll();
	}
});

test("falls back to endpoint matching when no provider is attributed", async () => {
	const harness = createHarness({ providers: { beta: { enabled: true } } });
	const transport = spyFetch();
	try {
		apply(harness.ctx);
		const matched = chatRequest(SHARED_ENDPOINT);
		await globalThis.fetch(matched.input, matched.init);
		const unmatched = chatRequest(OTHER_ENDPOINT);
		await globalThis.fetch(unmatched.input, unmatched.init);

		assert.equal(bodyOf(transport.calls[0]).encoding, "gzip");
		assert.equal(bodyOf(transport.calls[1]).encoding, "identity");
	} finally {
		transport.restore();
		harness.disposeAll();
	}
});

test("leaves small bodies, non-string bodies, and pre-encoded requests alone", async () => {
	const harness = createHarness({ providers: { beta: { enabled: true, minBytes: 1024 } } });
	const transport = spyFetch();
	try {
		apply(harness.ctx);
		const small = { input: `${SHARED_ENDPOINT}/chat/completions`, init: { method: "POST", headers: {}, body: "{}" } };
		await globalThis.fetch(small.input, small.init);

		const form = new FormData();
		form.set("purpose", "user_data");
		await globalThis.fetch(`${SHARED_ENDPOINT}/files`, { method: "POST", body: form });

		const already = chatRequest(SHARED_ENDPOINT);
		already.init.headers["content-encoding"] = "br";
		await globalThis.fetch(already.input, already.init);

		assert.equal(transport.calls.length, 3);
		assert.equal(bodyOf(transport.calls[0]).encoding, "identity", "below minBytes");
		assert.equal(transport.calls[1].init.body, form, "non-string bodies pass through untouched");
		assert.equal(transport.calls[2].init.headers["content-encoding"], "br", "an existing encoding is respected");
	} finally {
		transport.restore();
		harness.disposeAll();
	}
});

test("honours a per-provider minBytes threshold", async () => {
	const harness = createHarness({ providers: { beta: { enabled: true, minBytes: 65536 } } });
	const transport = spyFetch();
	try {
		apply(harness.ctx);
		const call = chatRequest(SHARED_ENDPOINT);
		await streamWithFetch(harness.listeners, "beta", () => globalThis.fetch(call.input, call.init));
		assert.equal(bodyOf(transport.calls[0]).encoding, "identity", "a 4 KiB body is below a 64 KiB threshold");
	} finally {
		transport.restore();
		harness.disposeAll();
	}
});

test("restores the original fetch when the plugin is disposed", async () => {
	const harness = createHarness({ providers: { beta: { enabled: true } } });
	const real = globalThis.fetch;
	apply(harness.ctx);
	assert.notEqual(globalThis.fetch, real, "the transport is patched while the plugin is mounted");
	harness.disposeAll();
	assert.equal(globalThis.fetch, real, "disposal must restore the original transport");
});

test("the schema keeps the section valid for dynamic provider routes", () => {
	const resolved = Config({ providers: { beta: { enabled: true }, gamma: { minBytes: 64 } } });
	assert.equal(resolved.providers.beta.enabled, true);
	assert.equal(resolved.providers.beta.minBytes, 1024, "minBytes default applies per route");
	assert.equal(resolved.providers.gamma.enabled, false, "enabled defaults to off");
	assert.equal(resolved.providers.gamma.minBytes, 64);
	assert.deepEqual(Config({}).providers, {}, "an absent section resolves to no policies");
	assert.equal(Config({}).timing, true, "the timing preference defaults to on");
	assert.equal(Config({ timing: false }).timing, false);
});

//#region end-to-end timing

/** Resolve after `ms`. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An OpenAI-style SSE endpoint whose phases are separated in time on purpose,
 * so each measured boundary can be attributed to the server behaviour that
 * produced it: think time before the response headers, then a gap before the
 * first token, then decode time across the remaining chunks.
 */
async function sseServer(plan) {
	const server = http.createServer(async (req, res) => {
		await new Promise((resolve) => {
			req.on("data", () => {});
			req.on("end", resolve);
		});
		await delay(plan.thinkMs);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
		res.flushHeaders();
		await delay(plan.firstTokenMs);
		const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
		for (let index = 0; index < plan.chunks; index++) {
			res.write(frame({ choices: [{ delta: { content: `t${index}` } }] }));
			if (index < plan.chunks - 1) await delay(plan.decodeMs / plan.chunks);
		}
		res.write(frame({ usage: { prompt_tokens: 12, completion_tokens: plan.outputTokens } }));
		res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, base: `http://127.0.0.1:${server.address().port}/v1` };
}

/**
 * A minimal OpenAI-compatible adapter: the real `fetch`, real SSE parsing, real
 * `StreamChunk`s. Only the provider-specific logic is absent, which is the
 * point — the plugin measures the transport, not the adapter.
 */
async function* readChatStream(base, body) {
	const response = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "text/event-stream" },
		body: JSON.stringify(body)
	});
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const piece of response.body) {
		buffer += decoder.decode(piece, { stream: true });
		let cut;
		while ((cut = buffer.indexOf("\n\n")) !== -1) {
			const frame = buffer.slice(0, cut);
			buffer = buffer.slice(cut + 2);
			const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
			if (line === undefined) continue;
			const payload = line.slice(6);
			if (payload === "[DONE]") {
				yield { type: "finish", reason: { kind: "stop" } };
				return;
			}
			const parsed = JSON.parse(payload);
			if (parsed.usage !== undefined) {
				yield { type: "usage", usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens } };
				continue;
			}
			const text = parsed.choices?.[0]?.delta?.content;
			if (typeof text === "string" && text.length > 0) yield { type: "text-delta", index: 0, text };
		}
	}
}

test("measures a real request end to end from transport diagnostics", async () => {
	const plan = { thinkMs: 60, firstTokenMs: 60, decodeMs: 120, chunks: 4, outputTokens: 40 };
	const { server, base } = await sseServer(plan);
	// No provider policy: timing must not depend on gzip being enabled.
	const harness = createHarness({});
	try {
		apply(harness.ctx);
		const waterfall = harness.listeners.get("llm/stream")[0];
		const inner = readChatStream(base, { messages: [{ role: "user", content: "x".repeat(50000) }] });
		const received = [];
		for await (const chunk of waterfall({ provider: "alpha", model: "test-model", sessionId: "session-1" }, () => inner)) received.push(chunk);

		assert.equal(received.filter((chunk) => chunk.type === "text-delta").length, 4, "the stream is passed through untouched");
		assert.equal(received.at(-1).type, "finish");

		const route = harness.routes.find((candidate) => candidate.methods.includes("GET"));
		assert.ok(route !== undefined, "the timing route is registered");
		assert.equal(route.path, "/api/llm-request-gzip/timings");
		const answer = await route.fetch(new Request("http://localhost/api/llm-request-gzip/timings?sessionId=session-1"));
		const payload = await answer.json();

		assert.equal(payload.measurements.length, 1);
		const [measured] = payload.measurements;
		assert.equal(measured.provider, "alpha");
		assert.equal(measured.model, "test-model");
		assert.equal(measured.sessionId, "session-1");
		assert.equal(measured.status, "complete");
		assert.equal(measured.attempts, 1);
		assert.equal(measured.outputTokens, 40);
		assert.equal(measured.compressed, false, "gzip is off for this provider");

		assert.ok(measured.sendMs !== null && measured.sendMs >= 0, "upload completion was observed");
		assert.ok(measured.sendMs < plan.thinkMs, `a 50 KB upload finishes before the server answers (got ${measured.sendMs}ms)`);
		assert.ok(measured.serverMs >= plan.thinkMs - 25, `server think time is visible (got ${measured.serverMs}ms)`);
		assert.ok(measured.ttftMs >= plan.thinkMs + plan.firstTokenMs - 30, `TTFT is measured from bodySent (got ${measured.ttftMs}ms)`);
		assert.ok(measured.generationMs >= plan.decodeMs - 40, `decode window is visible (got ${measured.generationMs}ms)`);
		assert.ok(measured.totalMs >= plan.thinkMs + plan.firstTokenMs, "total covers every phase");
		assert.ok(measured.tokensPerSecond > 0, "throughput is derived from the decode window");
		assert.ok(measured.requestBytes > 0 && measured.sentBytes === measured.requestBytes, "the request size is recorded even without gzip");
		assert.ok(measured.responseBytes > 0, "response bytes are counted from undici's chunks");

		// A different session must not see this one's requests.
		const other = await (await route.fetch(new Request("http://localhost/api/llm-request-gzip/timings?sessionId=session-2"))).json();
		assert.deepEqual(other.measurements, []);
	} finally {
		server.close();
		harness.disposeAll();
	}
});

test("records the compression actually applied to a measured request", async () => {
	const plan = { thinkMs: 10, firstTokenMs: 10, decodeMs: 20, chunks: 2, outputTokens: 5 };
	const { server, base } = await sseServer(plan);
	const harness = createHarness({ providers: { alpha: { enabled: true, minBytes: 0 } } });
	try {
		apply(harness.ctx);
		const waterfall = harness.listeners.get("llm/stream")[0];
		const inner = readChatStream(base, { messages: [{ role: "user", content: "x".repeat(20000) }] });
		for await (const _chunk of waterfall({ provider: "alpha", model: "test-model", sessionId: "s1" }, () => inner)) {
			// Drain.
		}
		const route = harness.routes.find((candidate) => candidate.methods.includes("GET"));
		const payload = await (await route.fetch(new Request("http://localhost/api/llm-request-gzip/timings?sessionId=s1"))).json();
		const [measured] = payload.measurements;
		assert.equal(measured.compressed, true, "the rewrite is reported as compression");
		assert.ok(measured.sentBytes < measured.requestBytes, "the sent size is smaller than the serialized size");
		assert.ok(measured.sendMs !== null, "timing still works alongside the gzip rewrite");
	} finally {
		server.close();
		harness.disposeAll();
	}
});

//#endregion

test("records nothing while the timing preference is off, but still applies gzip", async () => {
	const plan = { thinkMs: 10, firstTokenMs: 10, decodeMs: 20, chunks: 2, outputTokens: 5 };
	const { server, base } = await sseServer(plan);
	const harness = createHarness({ providers: { alpha: { enabled: true, minBytes: 0 } }, timing: false });
	try {
		apply(harness.ctx);
		const waterfall = harness.listeners.get("llm/stream")[0];
		const inner = readChatStream(base, { messages: [{ role: "user", content: "x".repeat(20000) }] });
		for await (const _chunk of waterfall({ provider: "alpha", model: "test-model", sessionId: "s1" }, () => inner)) {
			// Drain.
		}

		const route = harness.routes.find((candidate) => candidate.methods.includes("GET"));
		const payload = await (await route.fetch(new Request("http://localhost/api/llm-request-gzip/timings?sessionId=s1"))).json();
		assert.deepEqual(payload.measurements, [], "a switched-off ledger stores nothing");
	} finally {
		server.close();
		harness.disposeAll();
	}
});

test("turning the timing preference on and off takes effect on the next request", async () => {
	const plan = { thinkMs: 5, firstTokenMs: 5, decodeMs: 10, chunks: 2, outputTokens: 4 };
	const { server, base } = await sseServer(plan);
	const harness = createHarness({ timing: false });
	try {
		apply(harness.ctx);
		const waterfall = harness.listeners.get("llm/stream")[0];
		const drain = async () => {
			const inner = readChatStream(base, { messages: [{ role: "user", content: "hello" }] });
			for await (const _chunk of waterfall({ provider: "alpha", model: "test-model", sessionId: "s1" }, () => inner)) {
				// Drain.
			}
		};
		const route = harness.routes.find((candidate) => candidate.methods.includes("GET"));
		const readLedger = async () => (await (await route.fetch(new Request("http://localhost/api/llm-request-gzip/timings?sessionId=s1"))).json()).measurements;

		await drain();
		assert.equal((await readLedger()).length, 0);

		harness.setSection({ timing: true });
		await drain();
		assert.equal((await readLedger()).length, 1, "recording resumes once enabled");

		harness.setSection({ timing: false });
		await drain();
		assert.equal((await readLedger()).length, 1, "and stops again once disabled");
	} finally {
		server.close();
		harness.disposeAll();
	}
});

test("measures the server phase on every request of a pooled connection", async () => {
	// The first request opens the socket; the rest reuse it, and undici runs
	// their response diagnostics inside the FIRST request's async context. This
	// is the regression test for attributing by request identity instead of by
	// the ambient context.
	const plan = { thinkMs: 20, firstTokenMs: 20, decodeMs: 30, chunks: 2, outputTokens: 5 };
	const { server, base } = await sseServer(plan);
	const harness = createHarness({});
	try {
		apply(harness.ctx);
		const waterfall = harness.listeners.get("llm/stream")[0];
		for (let index = 0; index < 4; index++) {
			const inner = readChatStream(base, { messages: [{ role: "user", content: `turn ${index}` }] });
			for await (const _chunk of waterfall({ provider: "alpha", model: "test-model", sessionId: "pooled" }, () => inner)) {
				// Drain.
			}
		}

		const route = harness.routes.find((candidate) => candidate.methods.includes("GET"));
		const payload = await (await route.fetch(new Request("http://localhost/api/llm-request-gzip/timings?sessionId=pooled"))).json();
		assert.equal(payload.measurements.length, 4);
		for (const measured of payload.measurements) {
			assert.ok(measured.serverMs !== null, `request ${measured.id} lost its server phase`);
			assert.ok(measured.ttftMs !== null, `request ${measured.id} lost its TTFT`);
			assert.ok(measured.responseBytes > 0, `request ${measured.id} counted no response bytes`);
		}
	} finally {
		server.close();
		harness.disposeAll();
	}
});
