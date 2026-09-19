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
function createHarness(section = {}) {
	const listeners = new Map();
	const effects = [];
	let install;

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
			callback({ settings });
			return () => {};
		}
	};

	return { ctx, listeners, disposeAll: () => { for (const dispose of effects) dispose(); } };
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
});
