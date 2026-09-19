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
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { apply, Config, NS } from "../lib/index.js";

/** The namespace this plugin used before it was renamed. */
const LEGACY_NS = "llm-request-gzip";

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
function createHarness(initialSection = {}, options = {}) {
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

	const registered = [];
	const updates = [];
	const descriptors = {};
	const settings = {
		installSection(owner, ns, schema, base, hooks) {
			assert.equal(ns, NS);
			install = { schema, base, hooks };
			// Mirrors SettingsProvider.installSection: source, then the first change.
			hooks.setSource(() => schema({ ...base, ...section }));
			hooks.onChange();
		},
		register(ns) {
			registered.push(ns);
		},
		describe() {
			return [
				{ ns: NS, user: descriptors[NS] },
				{ ns: LEGACY_NS, user: descriptors[LEGACY_NS] }
			];
		},
		async update(ns, patch) {
			updates.push({ ns, patch });
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
			// A live agent whose inbox reports queued work, when a test asks for one.
			if (name === "agents") {
				if (options.pendingInput === undefined) return undefined;
				return {
					get: (sessionId) => options.pendingInput === true || options.pendingInput.includes(sessionId)
						? { inbox: { hasPending: true } }
						: undefined
				};
			}
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
			// Mirrors Cordis: the callback receives a context whose `get` resolves
			// exactly what was injected. `storage` is present only when a test asks
			// for one, which is also how a storage-less deployment behaves.
			const injected = { settings, connection };
			if (options.storage !== undefined) injected.storage = options.storage;
			callback({ get: (name) => injected[name], ...injected });
			return () => {};
		}
	};

	/** Replace the stored section and announce it, as a committed write would. */
	const setSection = (next) => {
		section = next;
		install.hooks.onChange();
	};

	return { ctx, listeners, routes, setSection, disposeAll: () => { for (const dispose of effects) dispose(); }, registered, updates, descriptors, LEGACY_NS };
}

/** Install a spy transport, returning the recorded calls and a restore hook. */
function spyFetch(plan = {}) {
	const calls = [];
	const real = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		calls.push({ url: String(input), init });
		const header = init?.headers?.["content-encoding"];
		if (plan.refuseBr === true && header === "br") {
			return new Response("unsupported media type", { status: 415 });
		}
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	};
	return { calls, restore: () => { globalThis.fetch = real; } };
}

/** Decode what actually went on the wire for one recorded call. */
function bodyOf(call) {
	const header = call.init.headers["content-encoding"];
	if (header === undefined) return { encoding: "identity", text: call.init.body };
	// Decode whichever algorithm the plugin chose, so assertions stay about the
	// body rather than about the codec.
	const decode = header === "br" ? brotliDecompressSync : gunzipSync;
	return { encoding: header, text: decode(Buffer.from(call.init.body)).toString("utf8") };
}

/**
 * Drive one streaming model call for `provider`, the way the agent loop does:
 * inside the `llm/stream` waterfall, with an `await` before the adapter reaches
 * `fetch` (proving the attribution scope survives suspension points).
 * @param listeners - recorded event listeners.
 * @param provider - the provider route being streamed.
 * @param request - the fetch call the fake adapter performs.
 */
async function streamWithFetch(listeners, provider, request, sessionId) {
	const waterfall = listeners.get("llm/stream")[0];
	const inner = (async function* adapter() {
		await new Promise((resolve) => setTimeout(resolve, 1));
		await request();
		yield { type: "text-delta", index: 0, text: "ok" };
	})();
	const call = sessionId === undefined ? { provider } : { provider, sessionId };
	for await (const _chunk of waterfall(call, () => inner)) {
		// Drain the stream exactly as the LLM service would.
	}
}

/** A chat-completions-shaped call, large enough to clear the default threshold. */
function chatRequest(url, body) {
	return {
		input: `${url}/chat/completions`,
		init: {
			method: "POST",
			headers: { authorization: "Bearer secret", "content-type": "application/json" },
			body: body ?? JSON.stringify({ messages: [{ role: "user", content: "x".repeat(4096) }] })
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

		assert.equal(beta.encoding, "br", "the enabled route is compressed, brotli first");
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
		assert.equal(headers["content-encoding"], "br");
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

		assert.equal(bodyOf(transport.calls[0]).encoding, "br");
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
/** A body the test already serialized itself, sent verbatim. */
class SerializedBody {
	constructor(text) {
		this.text = text;
	}
	toString() {
		return this.text;
	}
}

async function* readChatStream(base, body, finishKind = "stop") {
	const response = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "text/event-stream" },
		body: body instanceof SerializedBody ? body.toString() : JSON.stringify(body)
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
				yield { type: "finish", reason: { kind: finishKind } };
				return;
			}
			const parsed = JSON.parse(payload);
			if (parsed.usage !== undefined) {
				yield { type: "usage", usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens } };
				continue;
			}
			const toolCalls = parsed.choices?.[0]?.delta?.tool_calls;
			if (Array.isArray(toolCalls)) {
				for (const call of toolCalls) {
					yield {
						type: "tool-call-delta",
						id: call.id ?? "call_1",
						...call.function?.name === undefined ? {} : { name: call.function.name },
						argumentsDelta: call.function?.arguments ?? ""
					};
				}
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
		assert.equal(route.path, "/api/model-request-accelerator/timings");
		const answer = await route.fetch(new Request("http://localhost/api/model-request-accelerator/timings?sessionId=session-1"));
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
		const other = await (await route.fetch(new Request("http://localhost/api/model-request-accelerator/timings?sessionId=session-2"))).json();
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
		const payload = await (await route.fetch(new Request("http://localhost/api/model-request-accelerator/timings?sessionId=s1"))).json();
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
		const payload = await (await route.fetch(new Request("http://localhost/api/model-request-accelerator/timings?sessionId=s1"))).json();
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
		const readLedger = async () => (await (await route.fetch(new Request("http://localhost/api/model-request-accelerator/timings?sessionId=s1"))).json()).measurements;

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
		const payload = await (await route.fetch(new Request("http://localhost/api/model-request-accelerator/timings?sessionId=pooled"))).json();
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

test("reports the response content-encoding and counts wire bytes", async () => {
	// A realistic stream: enough repeated frames that gzip clearly wins.
	const frame = 'data: {"choices":[{"delta":{"content":"hello world"}}]}\n\n';
	const payload = frame.repeat(60) + "data: [DONE]\n\n";
	const compressed = gzipSync(Buffer.from(payload));
	const server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
			res.end(compressed);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}/v1`;
	const harness = createHarness({});
	try {
		apply(harness.ctx);
		const waterfall = harness.listeners.get("llm/stream")[0];
		const inner = readChatStream(base, { messages: [{ role: "user", content: "hi" }] });
		for await (const _chunk of waterfall({ provider: "alpha", model: "test-model", sessionId: "gzipped" }, () => inner)) {
			// Drain.
		}
		const route = harness.routes.find((candidate) => candidate.methods.includes("GET"));
		const payloadAnswer = await (await route.fetch(new Request("http://localhost/api/model-request-accelerator/timings?sessionId=gzipped"))).json();
		const [measured] = payloadAnswer.measurements;
		assert.equal(measured.responseEncoding, "gzip", "the wire encoding is read out of the diagnostic's header list");
		assert.equal(measured.responseBytes, compressed.byteLength, "wire bytes, not the decoded body");
		assert.ok(measured.responseBytes < Buffer.byteLength(payload), "the decoded stream is larger than what arrived");
	} finally {
		server.close();
		harness.disposeAll();
	}
});

test("leaves the response encoding null when the gateway does not compress", async () => {
	const plan = { thinkMs: 5, firstTokenMs: 5, decodeMs: 10, chunks: 2, outputTokens: 3 };
	const { server, base } = await sseServer(plan);
	const harness = createHarness({});
	try {
		apply(harness.ctx);
		const waterfall = harness.listeners.get("llm/stream")[0];
		const inner = readChatStream(base, { messages: [{ role: "user", content: "hi" }] });
		for await (const _chunk of waterfall({ provider: "alpha", model: "test-model", sessionId: "plain" }, () => inner)) {
			// Drain.
		}
		const route = harness.routes.find((candidate) => candidate.methods.includes("GET"));
		const answer = await (await route.fetch(new Request("http://localhost/api/model-request-accelerator/timings?sessionId=plain"))).json();
		assert.equal(answer.measurements[0].responseEncoding, null);
	} finally {
		server.close();
		harness.disposeAll();
	}
});

//#region pre-transmission

/**
 * A server that records the chunk timeline of every request, so a held request
 * can be told apart from an ordinary one and the wire bytes can be inspected.
 */
/** Poll until `predicate` holds, so a test can wait for an asynchronous side effect. */
async function waitFor(predicate, timeoutMs = 2000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return predicate();
}

async function recordingServer(plan = {}) {
	// `failAt` makes one specific request answer `status`; the rest behave.
	const requests = [];
	const sockets = new Set();
	const server = http.createServer((req, res) => {
		const started = Date.now();
		const record = {
			chunks: [],
			raw: [],
			completed: false,
			aborted: false,
			encoding: req.headers["content-encoding"] ?? null,
			transfer: req.headers["transfer-encoding"] ?? null,
			// Kept so a test can drop a held connection the way a gateway might.
			socket: req.socket
		};
		requests.push(record);
		req.on("data", (chunk) => {
			record.firstChunkAt ??= Date.now();
			record.lastChunkAt = Date.now();
			record.chunks.push({ at: Date.now() - started, size: chunk.length });
			record.raw.push(chunk);
		});
		req.on("aborted", () => {
			record.aborted = true;
		});
		req.on("end", () => {
			record.completed = true;
			if (plan.failAt !== undefined && requests.length === plan.failAt) {
				res.writeHead(plan.status ?? 503, { "content-type": "text/plain" });
				res.end("nope");
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const frames = [];
			if (plan.toolCall !== undefined) frames.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [plan.toolCall] } }] })}\n\n`);
			else frames.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
			frames.push("data: [DONE]\n\n");
			res.end(frames.join(""));
		});
	});
	// A held request keeps its socket open, which would otherwise leave the test
	// process waiting on `server.close()`.
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const close = () => {
		for (const socket of sockets) socket.destroy();
		server.close();
	};
	return { server, requests, close, base: `http://127.0.0.1:${server.address().port}/v1` };
}

/** Drive one complete model step for `messages`, as the agent loop would. */
async function runStep(harness, base, sessionId, messages, finishKind = "stop", rawBody) {
	const waterfall = harness.listeners.get("llm/stream")[0];
	const inner = readChatStream(base, rawBody === undefined ? { messages } : new SerializedBody(rawBody), finishKind);
	const received = [];
	for await (const chunk of waterfall({ provider: "alpha", model: "test-model", sessionId }, () => inner)) received.push(chunk);
	return received;
}

/** Read the timing ledger for one session. */
async function readLedger(harness, sessionId) {
	const route = harness.routes.find((candidate) => candidate.methods.includes("GET"));
	const answer = await route.fetch(new Request(`http://localhost/api/model-request-accelerator/timings?sessionId=${sessionId}`));
	return (await answer.json()).measurements;
}

test("pre-transmits the shared history across a pool, then sends only the increment", async () => {
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 3 });
	try {
		apply(harness.ctx);
		const history = [{ role: "user", content: "turn one ".repeat(200) }];
		await runStep(harness, base, "s1", history, "tool-calls");

		assert.ok(await waitFor(() => requests.length === 4), "the first step opened a pool of three held requests");
		const held = requests.slice(1);
		assert.equal(held.filter((entry) => !entry.completed && !entry.aborted).length, 3, "all three are held open");
		for (const member of held) {
			assert.ok(member.chunks.length >= 1, "each carries the history already");
			assert.equal(member.transfer, "chunked", "a body it cannot size yet is chunked");
		}

		const beforeSecondStep = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 30));
		await runStep(harness, base, "s1", [
			...history,
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "turn two" }
		], "tool-calls");

		// The oldest member — the one in flight longest — is the one consumed.
		assert.equal(held[0].completed, true, "the oldest member served the request");
		assert.ok(held[0].firstChunkAt <= beforeSecondStep, "its history was on the wire before the step was even issued");
		assert.ok(held[0].chunks.length >= 2, "the increment was written into it");
		assert.ok(held[0].chunks[0].size > held[0].chunks.at(-1).size, "the history dwarfs the increment");

		// The survivors were advanced to the new prefix, and the pool refilled.
		assert.ok(await waitFor(() => requests.length === 5), "the pool refilled itself");
		const survivors = requests.filter((entry) => !entry.completed && !entry.aborted);
		assert.equal(survivors.length, 3, "the pool is full again");
		assert.ok(survivors.some((entry) => entry.chunks.length >= 2), "the survivors were advanced, not reopened");

		const measurements = await readLedger(harness, "s1");
		assert.notEqual(measurements[1].prewarm, null, "the second step records its pre-transmission");
		// A pre-transmitted request still has to be measured as its own row, and
		// anchored at the claim rather than after its response came back.
		const [firstRow, secondRow] = measurements;
		assert.ok(secondRow.sendMs !== null && secondRow.sendMs >= 0, "the claim starts the send phase");
		assert.ok(secondRow.serverMs !== null, "the server phase is its own");
		assert.ok(secondRow.ttftMs !== null, "and so is the TTFT");
		assert.ok(secondRow.toFirstTokenMs !== null, "the wait to the first token is recorded");
		assert.ok(secondRow.toFirstTokenMs >= secondRow.ttftMs, "the wait covers at least the TTFT");
		assert.ok(secondRow.responseBytes > 0, "and it is charged its own response bytes");
		assert.ok(firstRow.responseBytes > 0 && firstRow.responseBytes <= secondRow.responseBytes * 2 + 200, "the previous row is not charged with them");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("abandons the whole pool when the history no longer matches", async () => {
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 2 });
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", [{ role: "user", content: "turn one" }], "tool-calls");
		assert.ok(await waitFor(() => requests.length === 3), "a pool of two is held");
		assert.equal(requests.filter((entry) => !entry.completed && !entry.aborted).length, 2);

		await runStep(harness, base, "s1", [{ role: "user", content: "a different history" }], "tool-calls");

		// The ordinary request, then a pool rebuilt from the captured prefix.
		assert.ok(await waitFor(() => requests.length === 6), "the mismatch fell back and re-opened a pool");
		assert.equal(requests[1].aborted, true, "the first member was abandoned");
		assert.equal(requests[2].aborted, true, "and so was the second");
		assert.equal(requests[3].transfer, null, "the ordinary path keeps a declared length");
		assert.equal(requests[3].completed, true);

		const measurements = await readLedger(harness, "s1");
		assert.equal(measurements[1].prewarm, null, "nothing is claimed that was not used");
		assert.equal(measurements[1].prewarmMiss, "mismatch", "and the row says why the pool was not used");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("pre-transmission composes with gzip instead of replacing it", async () => {
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { prewarm: true, enabled: true, minBytes: 0 } }, prewarmPoolSize: 2 });
	const first = [{ role: "user", content: "x".repeat(20000) }];
	const second = [...first, { role: "assistant", content: "ok" }];
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", first, "tool-calls");
		assert.ok(await waitFor(() => requests.length === 3 && requests[1].chunks.length > 0), "a pool is held");
		const beforeSecondStep = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 30));
		await runStep(harness, base, "s1", second, "tool-calls");

		const held = requests[1];
		assert.equal(held.encoding, "br", "the held request is compressed, keeping the compression");
		assert.equal(held.completed, true);
		assert.ok(held.firstChunkAt <= beforeSecondStep, "the compressed history went out before the second step");

		const wire = Buffer.concat(held.raw);
		const codec = held.encoding === "br" ? brotliDecompressSync : gunzipSync;
		assert.deepEqual(JSON.parse(codec(wire).toString("utf8")), { messages: second }, "the parts decompress as one stream");
		assert.ok(wire.byteLength < Buffer.byteLength(JSON.stringify({ messages: second })), "and it is still compressed");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("destroys the whole pool when the step ends the turn", async () => {
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 3 });
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", [{ role: "user", content: "hello" }], "stop");

		assert.ok(await waitFor(() => requests.length === 4), "the call opened the pool");
		assert.ok(await waitFor(() => requests.slice(1).every((entry) => entry.aborted === true || entry.completed === true)), "the pool was destroyed");
		assert.equal(requests.filter((entry) => !entry.completed && !entry.aborted).length, 0, "nothing is left held");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("bounds the total number of held requests across conversations", async () => {
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 2 });
	try {
		apply(harness.ctx);
		for (const session of ["s1", "s2", "s3"]) await runStep(harness, base, session, [{ role: "user", content: session }], "tool-calls");
		// Two per conversation, three conversations.
		assert.ok(await waitFor(() => requests.filter((entry) => !entry.completed && !entry.aborted).length === 6), "each conversation holds its own pool");
		assert.equal(requests.filter((entry) => !entry.completed && !entry.aborted).length, 6);
	} finally {
		harness.disposeAll();
		close();
	}
});

test("adds the assistant turn to the pool while the tools run", async () => {
	const call = { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } };
	const { close, requests, base } = await recordingServer({ toolCall: call });
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 1 });
	try {
		apply(harness.ctx);
		// A template the predictor can learn from: a prior assistant turn that also
		// carries tool calls, in the same key order the adapter will emit.
		const history = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "read", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "c0", content: "ok" }
		];
		await runStep(harness, base, "s1", history, "tool-calls");

		// The assistant turn reaches the held request during the tool window, before
		// the request that will need it has been issued.
		assert.ok(await waitFor(() => requests.length === 2 && requests[1].chunks.length >= 2), "the turn was appended to the held request");
		const held = requests[1];
		const beforeSecondStep = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.ok(held.lastChunkAt <= beforeSecondStep, "and it went out before the next step was issued");

		const next = [
			...history,
			{ role: "assistant", content: null, tool_calls: [call] },
			{ role: "tool", tool_call_id: "call_1", content: "file.txt" }
		];
		await runStep(harness, base, "s1", next, "tool-calls");

		assert.equal(held.completed, true, "the held request served the step");
		const body = Buffer.concat(held.raw).toString("utf8");
		assert.match(body, /"tool_calls":\[\{"id":"call_1"/u, "the predicted turn was already on the wire");
		assert.ok(await waitFor(() => requests.length === 3), "the pool refilled for the step after");
		assert.equal(requests[2].completed, false, "and the replacement is held");
	} finally {
		harness.disposeAll();
		close();
	}
});

//#endregion



/** A storage backend stand-in: one durable record per session, like the real one. */
function fakeStorage(seed = {}) {
	const table = new Map(Object.entries(seed));
	return {
		table,
		domain: {
			// Mirrors the real `Domain` handle: tables are resolved by name through
			// `table()`, which is the whole reason this fake exists — modelling the
			// assumption instead of the contract is how the first version of the
			// ledger passed its tests while never writing anything.
			async open() {
				return {
					table(name) {
						assert.equal(name, "sessions");
						return {
							get: (key) => table.get(key),
							put: async (key, value) => {
								table.set(key, value);
							},
							delete: async (key) => table.delete(key),
							get size() {
								return table.size;
							}
						};
					},
					close: async () => {}
				};
			}
		}
	};
}

/** Poll the timing route until it reports `count` rows, or the deadline passes. */
async function waitForLedger(harness, sessionId, count, timeoutMs = 1500) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const rows = await fetchLedger(harness, sessionId);
		if (rows.length === count || Date.now() > deadline) return rows;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Call the timing route and keep the response, status included. */
async function callLedger(harness, sessionId) {
	const route = harness.routes.find((candidate) => candidate.methods.includes("GET"));
	return route.fetch(new Request(`http://localhost/api/model-request-accelerator/timings?sessionId=${sessionId}`));
}

/** Read the timing route of a harness. */
async function fetchLedger(harness, sessionId) {
	const route = harness.routes.find((candidate) => candidate.methods.includes("GET"));
	return (await (await route.fetch(new Request(`http://localhost/api/model-request-accelerator/timings?sessionId=${sessionId}`))).json()).measurements;
}

test("rebuilds the pool from the new prefix after a mismatch", async () => {
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 2 });
	const held = () => requests.filter((entry) => !entry.completed && !entry.aborted);
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", [{ role: "user", content: "turn one" }], "tool-calls");
		assert.ok(await waitFor(() => held().length === 2), "a pool of two is held");

		// A rewritten history: nothing in the pool continues it.
		const rewritten = [{ role: "user", content: "a different history" }];
		await runStep(harness, base, "s1", rewritten, "tool-calls");
		assert.equal(requests[1].aborted, true, "the old pool is abandoned");
		assert.equal(requests[2].aborted, true);
		// Re-opened from the prefix that was just captured, not left empty.
		assert.ok(await waitFor(() => held().length === 2), "a fresh pool is held for the new history");

		await runStep(harness, base, "s1", [...rewritten, { role: "assistant", content: "ok" }], "tool-calls");
		const measurements = await readLedger(harness, "s1");
		assert.notEqual(measurements[2].prewarm, null, "the rebuilt pool serves the following step");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("keeps the pool across a turn boundary while input is queued", async () => {
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 2 }, { pendingInput: true });
	const held = () => requests.filter((entry) => !entry.completed && !entry.aborted);
	try {
		apply(harness.ctx);
		// A turn that ends `stop`, which normally releases the pool outright.
		await runStep(harness, base, "s1", [{ role: "user", content: "hi" }], "stop");
		assert.ok(await waitFor(() => held().length === 2), "the pool is held");
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(held().length, 2, "and it survives the turn boundary because a turn is already queued");

		// The queued turn repeats this history, so the pool serves it.
		await runStep(harness, base, "s1", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "next" }], "stop");
		const measurements = await readLedger(harness, "s1");
		assert.notEqual(measurements[1].prewarm, null, "the queued turn reused the pool");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("keeps a separate pool for every agent, even with identical histories", async () => {
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 1 });
	const held = () => requests.filter((entry) => !entry.completed && !entry.aborted);
	try {
		apply(harness.ctx);
		// A subagent is a separate agent with its own session, so these two are as
		// separate as any parent and child. Identical histories are the hard case:
		// a shared key would let the child consume the parent's held request,
		// because its bytes match perfectly.
		const history = [{ role: "user", content: "same words" }];
		await runStep(harness, base, "session-parent", history, "tool-calls");
		assert.ok(await waitFor(() => held().length === 1), "the parent holds one request");
		const parentMember = held()[0];

		await runStep(harness, base, "session-child", history, "tool-calls");
		assert.ok(await waitFor(() => held().length === 2), "the child opened its own instead");
		assert.equal(parentMember.completed, false, "the parent's request was never consumed by the child");
		assert.equal(parentMember.aborted, false, "and never abandoned either");

		// Each continues from its own pool.
		await runStep(harness, base, "session-child", [...history, { role: "assistant", content: "ok" }], "tool-calls");
		assert.equal(parentMember.completed, false, "the child still did not touch the parent's request");
		const childRows = await readLedger(harness, "session-child");
		assert.notEqual(childRows[1].prewarm, null, "the child used its own pool");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("reads queued input from the agent's own session, not the whole tree", async () => {
	const { close, requests, base } = await recordingServer();
	// Only the parent has something queued; the child is finishing its last turn.
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 1 }, { pendingInput: ["session-parent"] });
	const held = () => requests.filter((entry) => !entry.completed && !entry.aborted);
	try {
		apply(harness.ctx);
		await runStep(harness, base, "session-parent", [{ role: "user", content: "parent" }], "stop");
		assert.ok(await waitFor(() => held().length === 1), "the parent's pool survives its turn boundary");

		const parentMember = held()[0];
		await runStep(harness, base, "session-child", [{ role: "user", content: "child" }], "stop");
		// The child has nothing queued, so its pool is released at its turn
		// boundary — and the parent's, which does, is left untouched.
		assert.ok(await waitFor(() => held().length === 1), "only the child's pool was released");
		assert.equal(held()[0], parentMember, "the survivor is the parent's own request");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("does not give up on an endpoint for one transient failure", async () => {
	// The held request — the second one — answers 503. A transient failure must
	// not switch pre-transmission off for the endpoint.
	const { close, requests, base } = await recordingServer({ failAt: 2, status: 503 });
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 1 });
	const held = () => requests.filter((entry) => !entry.completed && !entry.aborted);
	const history = [{ role: "user", content: "one" }];
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", history, "tool-calls");
		assert.ok(await waitFor(() => held().length === 1), "a request is held");
		await runStep(harness, base, "s1", [...history, { role: "assistant", content: "ok" }], "tool-calls");

		await runStep(harness, base, "s1", [...history, { role: "assistant", content: "ok" }, { role: "assistant", content: "more" }], "tool-calls");
		assert.ok(await waitFor(() => held().length >= 1), "an endpoint that answered 503 once is still pre-transmitted to");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("gives up on an endpoint that refuses a chunked body", async () => {
	// 415 is about the body shape, so retrying pre-transmission cannot help.
	const { close, requests, base } = await recordingServer({ failAt: 2, status: 415 });
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 1 });
	const held = () => requests.filter((entry) => !entry.completed && !entry.aborted);
	const history = [{ role: "user", content: "one" }];
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", history, "tool-calls");
		assert.ok(await waitFor(() => held().length === 1), "a request is held");

		// Claimed, refused, and re-sent as an ordinary request.
		await runStep(harness, base, "s1", [...history, { role: "assistant", content: "ok" }], "tool-calls");
		assert.ok(await waitFor(() => requests.some((entry) => entry.transfer === null && entry.completed)), "the refused request was re-sent normally");

		await runStep(harness, base, "s1", [...history, { role: "assistant", content: "ok" }, { role: "assistant", content: "more" }], "tool-calls");
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(held().length, 0, "and no further request is held for that endpoint");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("never tries brotli when gzip is chosen", async () => {
	const harness = createHarness({ encoding: "gzip", providers: { beta: { enabled: true } } });
	const transport = spyFetch();
	try {
		apply(harness.ctx);
		const call = chatRequest(SHARED_ENDPOINT);
		await streamWithFetch(harness.listeners, "beta", () => globalThis.fetch(call.input, call.init));
		const wire = bodyOf(transport.calls[0]);
		assert.equal(wire.encoding, "gzip", "the algorithm is honoured");
		assert.equal(wire.text, call.init.body, "and the body survives it");
	} finally {
		transport.restore();
		harness.disposeAll();
	}
});

test("retries as gzip when an endpoint refuses brotli, then remembers it", async () => {
	const harness = createHarness({ providers: { beta: { enabled: true } } });
	const transport = spyFetch({ refuseBr: true });
	try {
		apply(harness.ctx);
		const first = chatRequest(SHARED_ENDPOINT);
		await streamWithFetch(harness.listeners, "beta", () => globalThis.fetch(first.input, first.init));

		const bodies = transport.calls.map((call) => bodyOf(call));
		assert.deepEqual(bodies.map((entry) => entry.encoding), ["br", "gzip"], "the refused brotli body is retried as gzip");
		assert.equal(bodies[1].text, first.init.body, "and the retry carries exactly the same body");

		const second = chatRequest(SHARED_ENDPOINT);
		await streamWithFetch(harness.listeners, "beta", () => globalThis.fetch(second.input, second.init));
		assert.deepEqual(transport.calls.map((call) => call.init.headers["content-encoding"]), ["br", "gzip", "gzip"], "the endpoint is not tried again");
	} finally {
		transport.restore();
		harness.disposeAll();
	}
});

test("keeps brotli off its slow quality curve, and counts that time as preparation", async () => {
	// Brotli's own default is quality 11: about a second of synchronous CPU per
	// megabyte, for a few percent over quality 9. A body this size makes the
	// difference unmistakable, and the preparation phase must show the cost
	// rather than charging it to the upload.
	const body = JSON.stringify({
		messages: Array.from({ length: 4000 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: randomBytes(48).toString("hex")
		}))
	});
	const harness = createHarness({ providers: { beta: { enabled: true, minBytes: 0 } } });
	const transport = spyFetch();
	try {
		apply(harness.ctx);
		const call = chatRequest(SHARED_ENDPOINT, body);
		await streamWithFetch(harness.listeners, "beta", () => globalThis.fetch(call.input, call.init), "s1");

		const [measurement] = await readLedger(harness, "s1");
		assert.equal(measurement.encoding, "br", "brotli is the algorithm in use");
		assert.ok(measurement.sentBytes < measurement.requestBytes, "and it compressed the body");
		assert.ok(measurement.prepareMs > 0, "the compression happens inside the preparation phase");
		assert.ok(measurement.prepareMs < 400, `preparation took ${measurement.prepareMs}ms, so the quality is not capped`);
	} finally {
		transport.restore();
		harness.disposeAll();
	}
});

test("records which algorithm compressed each request", async () => {
	const gzipHarness = createHarness({ encoding: "gzip", providers: { beta: { enabled: true } } });
	const brHarness = createHarness({ providers: { beta: { enabled: true } } });
	const transport = spyFetch();
	try {
		apply(gzipHarness.ctx);
		const first = chatRequest(SHARED_ENDPOINT);
		await streamWithFetch(gzipHarness.listeners, "beta", () => globalThis.fetch(first.input, first.init), "s1");
		assert.equal((await readLedger(gzipHarness, "s1"))[0].encoding, "gzip");
		gzipHarness.disposeAll();

		apply(brHarness.ctx);
		const second = chatRequest(SHARED_ENDPOINT);
		await streamWithFetch(brHarness.listeners, "beta", () => globalThis.fetch(second.input, second.init), "s1");
		assert.equal((await readLedger(brHarness, "s1"))[0].encoding, "br");
	} finally {
		transport.restore();
		gzipHarness.disposeAll();
		brHarness.disposeAll();
	}
});

test("records a claimed pre-transmission that died in the handover", async () => {
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 1 });
	const history = [{ role: "user", content: "turn one" }];
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", history, "tool-calls");
		assert.ok(await waitFor(() => requests.filter((entry) => !entry.completed && !entry.aborted).length === 1), "a request is held");

		// The gateway drops the held connection before the increment is written,
		// which the member cannot show until the handover actually happens.
		for (const entry of requests) if (!entry.completed) entry.socket?.destroy();
		await runStep(harness, base, "s1", [...history, { role: "assistant", content: "ok" }], "tool-calls");

		const measurements = await readLedger(harness, "s1");
		assert.equal(measurements[1].prewarm, null, "the request was not served from the pool");
		assert.equal(measurements[1].prewarmMiss, "failed", "and the row says the handover is why");
		assert.ok(measurements[1].attempts >= 2, "the request went out the ordinary way instead");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("carries settings across from the plugin's former name", () => {
	const harness = createHarness({ providers: {} });
	// What the user actually configured under the old name.
	const stored = { providers: { beta: { enabled: true, prewarm: true } }, prewarmPoolSize: 5 };
	harness.descriptors[harness.LEGACY_NS] = stored;
	apply(harness.ctx);

	assert.ok(harness.registered.includes(harness.LEGACY_NS), "the former namespace is registered, so its section stays readable");
	assert.deepEqual(harness.updates, [{ ns: NS, patch: stored }], "and the user's section is carried to the new one");
});

test("leaves a namespace alone once the user has configured the new name", () => {
	const harness = createHarness({ providers: {} });
	harness.descriptors[harness.LEGACY_NS] = { providers: { beta: { enabled: true } } };
	harness.descriptors[NS] = { timing: false };
	apply(harness.ctx);

	assert.deepEqual(harness.updates, [], "the migration stands down rather than overwriting a newer section");
});

test("does nothing when there was never anything under the former name", () => {
	const harness = createHarness({ providers: {} });
	apply(harness.ctx);
	assert.deepEqual(harness.updates, [], "an empty section carries nothing");
});

test("reports a pre-transmitted request's compressed size and algorithm", async () => {
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { enabled: true, minBytes: 0, prewarm: true } }, prewarmPoolSize: 1 });
	const history = [{ role: "user", content: "y".repeat(20000) }];
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", history, "tool-calls");
		assert.ok(await waitFor(() => requests.filter((entry) => !entry.completed && !entry.aborted).length === 1), "a request is held");
		await runStep(harness, base, "s1", [...history, { role: "assistant", content: "ok" }], "tool-calls");

		const held = requests[1];
		assert.equal(held.encoding, "br", "the member went out compressed");
		const measurement = (await readLedger(harness, "s1"))[1];
		assert.notEqual(measurement.prewarm, null, "the row was served from the pool");
		assert.equal(measurement.encoding, "br", "and it names the algorithm the member used");
		assert.equal(measurement.compressed, true, "and it does not read as uncompressed");
		assert.ok(measurement.sentBytes < measurement.requestBytes, "the wire size is smaller than the body");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("pre-sends only what every framing agrees on, so nothing is a guess", async () => {
	// The model streamed arguments with spaces, and the turn produced no text — so
	// the adapter's own framing differs from the model's bytes in two ways at once:
	// it re-serializes the arguments, and it omits `content` on a textless turn.
	// The pre-sent bytes stop where those framings diverge, which keeps the member
	// valid whatever the adapter does, instead of discarding a whole pool over it.
	const streamed = { id: "call_1", type: "function", function: { name: "bash", arguments: '{ "cmd" : "ls" }' } };
	const { close, requests, base } = await recordingServer({ toolCall: streamed });
	const harness = createHarness({ providers: { alpha: { prewarm: true } }, prewarmPoolSize: 3 });
	const history = [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "read", arguments: "{}" } }] },
		{ role: "tool", tool_call_id: "c0", content: "ok" }
	];
	// What the adapter actually sends next: no `content`, re-serialized arguments.
	const next = JSON.stringify({
		messages: [
			...history,
			{ role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }] },
			{ role: "tool", tool_call_id: "call_1", content: "file.txt" }
		]
	});
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", history, "tool-calls");
		assert.ok(await waitFor(() => requests.filter((entry) => !entry.completed && !entry.aborted).length === 3), "a pool of three is held");

		await runStep(harness, base, "s1", null, "tool-calls", next);

		const measurements = await readLedger(harness, "s1");
		assert.notEqual(measurements[1].prewarm, null, "the pre-sent bytes were a prefix of what the adapter built, so the pool was used");
		assert.equal(measurements[1].prewarmMiss, null, "and nothing was recorded as a lost bet");
		// Which member served it depends on which variant matched; what must not
		// happen is a fresh upload, which is the only request with a declared length.
		assert.equal(requests.filter((entry) => entry.transfer === null).length, 1, "no request was re-uploaded the ordinary way");
		assert.equal(requests.filter((entry) => entry.completed).length, 2, "a held member served the step instead of a new request");
	} finally {
		harness.disposeAll();
		close();
	}
});


test("writes each session's ledger and loads it back", async () => {
	const { close, base } = await recordingServer();
	const storage = fakeStorage();
	const harness = createHarness({ providers: {} }, { storage });
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", [{ role: "user", content: "one" }], "stop");
		assert.ok(await waitFor(() => storage.table.has("s1")), "the session's rows were written");
		const stored = storage.table.get("s1");
		assert.equal(stored.rows.length, 1, "one row");
		assert.equal(stored.rows[0].provider, "alpha", "with the measurement in it");
		assert.equal(typeof stored.updatedAt, "number");

		// A fresh process over the same storage: the panel must show the history
		// rather than an empty table.
		const restarted = createHarness({ providers: {} }, { storage });
		try {
			apply(restarted.ctx);
			const rows = await waitForLedger(restarted, "s1", 1);
			assert.equal(rows.length, 1, "the stored row is served again");
			assert.equal(rows[0].provider, "alpha");
			assert.equal(rows[0].totalMs !== undefined, true);
		} finally {
			restarted.disposeAll();
		}
	} finally {
		harness.disposeAll();
		close();
	}
});

test("a session with no stored rows still works, and never overwrites live ones", async () => {
	const storage = fakeStorage({ s1: { updatedAt: 1, rows: [{ id: 1, provider: "old", model: null, totalMs: 5 }] } });
	const harness = createHarness({ providers: {} }, { storage });
	try {
		apply(harness.ctx);
		const rows = await waitForLedger(harness, "s1", 1);
		assert.equal(rows.length, 1, "the stored row shows up");
		assert.equal(rows[0].provider, "old", "and it is the stored one");
	} finally {
		harness.disposeAll();
	}
});

test("keeps pre-transmitted requests compressed after one has been claimed", async () => {
	// The claim skips compressing the body, and that must not read as "this
	// conversation is not compressed" — otherwise every member opened afterwards
	// goes out uncompressed, and within one pool the whole pool does.
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { enabled: true, minBytes: 0, prewarm: true } }, prewarmPoolSize: 2 });
	const history = [{ role: "user", content: "y".repeat(20000) }];
	const held = () => requests.filter((entry) => !entry.completed && !entry.aborted);
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", history, "tool-calls");
		await runStep(harness, base, "s1", [...history, { role: "assistant", content: "ok" }], "tool-calls");
		await runStep(harness, base, "s1", [...history, { role: "assistant", content: "ok" }, { role: "assistant", content: "more" }], "tool-calls");

		assert.ok(await waitFor(() => held().length >= 2), "a pool is held after the claimed steps");
		const encodings = held().map((entry) => entry.encoding);
		assert.ok(encodings.length > 0 && encodings.every((encoding) => encoding === "br"), `every held member is still compressed, saw ${encodings.join(",")}`);
	} finally {
		harness.disposeAll();
		close();
	}
});

test("answers for a session that has no records at all", async () => {
	// The most ordinary state there is: nothing has run in this session yet. The
	// panel must get an empty list, not an error.
	const harness = createHarness({ providers: {} });
	try {
		apply(harness.ctx);
		const answer = await callLedger(harness, "never-ran");
		assert.equal(answer.status, 200, "an empty session is not an error");
		assert.deepEqual((await answer.json()).measurements, []);
	} finally {
		harness.disposeAll();
	}
});

test("answers for a session whose stored ledger cannot be read", async () => {
	// A storage fault must degrade to "no history", never to a broken panel.
	const storage = {
		domain: {
			async open() {
				return {
					table() {
						throw new Error("storage is unavailable");
					},
					close: async () => {}
				};
			}
		}
	};
	const harness = createHarness({ providers: {} }, { storage });
	try {
		apply(harness.ctx);
		assert.ok(await waitFor(() => harness.routes.length > 0));
		const answer = await callLedger(harness, "s1");
		assert.equal(answer.status, 200, "a store that will not read is not a panel error");
		assert.deepEqual((await answer.json()).measurements, []);
	} finally {
		harness.disposeAll();
	}
});

test("reports the increment on the wire, and what it is made of", async () => {
	// A real body carries fields after `messages` — the tool schemas above all —
	// which no prefix can reach, so they are re-sent every time. The row must say
	// so, and must not present the uncompressed text as the wire size.
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { enabled: true, minBytes: 0, prewarm: true } }, prewarmPoolSize: 1 });
	const history = [{ role: "user", content: "y".repeat(20000) }];
	try {
		apply(harness.ctx);
		// Both bodies carry the trailing fields a real adapter sends, in the same
		// order, so the second is genuinely a continuation of the first.
		const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }];
		await runStep(harness, base, "s1", null, "tool-calls", JSON.stringify({ model: "test-model", messages: history, stream: true, tools }));
		await runStep(harness, base, "s1", null, "tool-calls", JSON.stringify({
			model: "test-model",
			messages: [...history, { role: "assistant", content: "ok" }, { role: "tool", tool_call_id: "c", content: "done" }],
			stream: true,
			tools
		}));

		const measurement = (await readLedger(harness, "s1"))[1];
		const prewarm = measurement.prewarm;
		assert.notEqual(prewarm, null, "the step was served from the pool");
		assert.ok(prewarm.deltaWireBytes > 0, "the wire increment is recorded");
		assert.ok(prewarm.deltaWireBytes < prewarm.deltaBytes, "and it is smaller than the text it encodes");
		assert.ok(prewarm.tailBytes > 0, "the part after the messages array is measured");
		assert.ok(prewarm.tailBytes < prewarm.deltaBytes, "and it is part of the increment, not all of it");
	} finally {
		harness.disposeAll();
		close();
	}
});

test("moves the fixed fields after messages, so the prefix covers them", async () => {
	const { close, requests, base } = await recordingServer();
	const harness = createHarness({ providers: { alpha: { enabled: true, minBytes: 0, prewarm: true } }, prewarmPoolSize: 2 });
	const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }];
	const history = [{ role: "user", content: "y".repeat(2000) }];
	const decode = (entry) => (entry.encoding === "br" ? brotliDecompressSync : gunzipSync)(Buffer.concat(entry.raw)).toString("utf8");
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", null, "tool-calls", JSON.stringify({ model: "m", messages: history, stream: true, tools }));
		await runStep(harness, base, "s1", null, "tool-calls", JSON.stringify({ model: "m", messages: [...history, { role: "assistant", content: "ok" }], stream: true, tools }));

		// The body that went out carries the fixed fields first, with the messages
		// untouched.
		const first = decode(requests[0]);
		assert.ok(first.indexOf('"tools"') < first.indexOf('"messages"'), "the adapter's order is replaced by one the prefix can use");
		assert.deepEqual(JSON.parse(first).messages, history, "and the messages themselves are untouched");

		// The step that followed was served from the pool, and almost nothing was
		// left to write: the tool schemas now travel inside the prefix.
		const rows = await readLedger(harness, "s1");
		assert.notEqual(rows[1].prewarm, null, "the reordered body still matches a held member");
		assert.ok(rows[1].prewarm.tailBytes <= 4, `only the closing brackets remain after messages, saw ${rows[1].prewarm.tailBytes}`);
		assert.ok(rows[1].prewarm.deltaBytes < 2000, `the increment is just the new turn, saw ${rows[1].prewarm.deltaBytes}`);
	} finally {
		harness.disposeAll();
		close();
	}
});

test("sends the original field order again if an endpoint rejects the reordered body", async () => {
	const { close, requests, base } = await recordingServer({ failAt: 1, status: 400 });
	const harness = createHarness({ providers: { alpha: { enabled: true, minBytes: 0, prewarm: true } }, prewarmPoolSize: 1 });
	const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }];
	try {
		apply(harness.ctx);
		await runStep(harness, base, "s1", null, "tool-calls", JSON.stringify({ model: "m", messages: [{ role: "user", content: "y".repeat(2000) }], stream: true, tools }));

		assert.ok(await waitFor(() => requests.length >= 2), "the rejected request was sent again");
		await waitFor(() => requests[1].completed === true, 500);
		const codec = requests[1].encoding === "br" ? brotliDecompressSync : gunzipSync;
		const wire = codec(Buffer.concat(requests[1].raw)).toString("utf8");
		assert.ok(wire.indexOf('"messages"') < wire.indexOf('"tools"'), "the retry keeps the adapter's own order");

		// And the endpoint is not tried in the canonical order again.
		await runStep(harness, base, "s1", null, "tool-calls", JSON.stringify({ model: "m", messages: [{ role: "user", content: "y".repeat(2000) }], stream: true, tools }));
		const later = requests.filter((entry) => entry.completed && entry.encoding !== null).at(-1);
		const laterWire = (later.encoding === "br" ? brotliDecompressSync : gunzipSync)(Buffer.concat(later.raw)).toString("utf8");
		assert.ok(laterWire.indexOf('"messages"') < laterWire.indexOf('"tools"'), "the refusal is remembered");
	} finally {
		harness.disposeAll();
		close();
	}
});
