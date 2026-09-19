/**
 * Contract test for the browser half.
 *
 * The bundle is plain JavaScript loaded through `window.__ModuleLoader__.load`,
 * so it can be executed directly under Node with a stubbed loader and a stubbed
 * `react`. This pins the two things that fail silently in the browser: the
 * bundle id agreeing with the package name the Host resolves, and the card
 * landing on the `settings.plugin.item` key the Plugins page dispatches.
 *
 * Run: node --test test/
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const PACKAGE_NAME = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name;
const SITE = "https://gateway.example/v1";

/** A React stub that is never actually rendered: only the hooks are touched. */
const ReactStub = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [initial, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn
};

/** Execute the bundle against a stubbed loader and return its module exports. */
function loadBundle() {
	let loaded;
	const previousWindow = globalThis.window;
	globalThis.window = {
		__ModuleLoader__: {
			load(entry) {
				loaded = entry;
			}
		}
	};
	try {
		// eslint-disable-next-line no-new-func -- the bundle is the artifact under test
		new Function(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"))();
	} finally {
		if (previousWindow === undefined) delete globalThis.window;
		else globalThis.window = previousWindow;
	}
	assert.ok(loaded !== undefined, "the bundle must call __ModuleLoader__.load");
	return {
		entry: loaded,
		exports: loaded.factory((name) => {
			if (name === "react") return ReactStub;
			throw new Error(`unexpected require("${name}")`);
		})
	};
}

/** A fake client context that records the slot registration it receives. */
function createClientContext() {
	const harness = { registration: undefined };
	const ctx = {
		remote: {
			settings: {
				async describe() {
					return {
						ok: true,
						value: {
							writable: true,
							hasDocument: true,
							namespaces: [
								{
									ns: "llm-request-gzip",
									applies: "live",
									revision: 7,
									secrets: [],
									value: { providers: { beta: { enabled: true, minBytes: 4096 } } }
								},
								{ ns: "llm-alpha", applies: "live", revision: 1, secrets: [], value: { baseURL: SITE } },
								{ ns: "llm-beta", applies: "live", revision: 1, secrets: [], value: { providers: { beta: { baseURL: SITE } } } }
							]
						}
					};
				},
				async mutate(ns, ops, revision) {
					ctx.writes.push({ ns, ops, revision });
					return { ok: true, value: { ns, revision: revision + 1 } };
				}
			},
			llm: {
				async listProviders() {
					return {
						ok: true,
						value: [
							{ id: "alpha", name: "Alpha" },
							{ id: "beta", name: "Beta" }
						]
					};
				},
				async listConfigurableProviders() {
					return {
						ok: true,
						value: [
							{ provider: "alpha", displayName: "Alpha", settingsNs: "llm-alpha", settingsPath: [] },
							{ provider: "beta", displayName: "Beta", settingsNs: "llm-beta", settingsPath: ["providers", "beta"] }
						]
					};
				}
			}
		},
		writes: [],
		slots: {
			inject(key, callback) {
				ctx.injected = key;
				callback();
				return () => {};
			},
			register(options, component) {
				harness.registration = { options, component };
				return () => {};
			}
		}
	};
	return Object.assign(harness, { ctx });
}

test("the bundle id matches the package name the Host resolves", () => {
	const { entry } = loadBundle();
	assert.equal(entry.id, PACKAGE_NAME, "client-modules keys the graph by package name");
});

test("registers the card on the namespace key the Plugins page dispatches", () => {
	const { exports } = loadBundle();
	assert.equal(typeof exports.apply, "function");
	assert.deepEqual([...exports.inject], ["slots", "remote", "remote.settings", "remote.llm"]);

	const harness = createClientContext();
	exports.apply(harness.ctx);
	const { ctx, registration } = harness;
	assert.equal(ctx.injected, "settings.plugin.item");
	assert.equal(registration.options.name, "settings.plugin.item");
	assert.equal(registration.options.key, "llm-request-gzip", "the key must equal the served settings namespace");
	assert.equal(typeof registration.component, "function");

	const props = registration.options.inject();
	assert.equal(typeof props.ctl.read, "function");
	assert.equal(typeof props.ctl.write, "function");
});

test("joins the provider directory with the stored policy and both profile shapes", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const { ctl } = harness.registration.options.inject();

	const snapshot = await ctl.read();
	assert.equal(snapshot.writable, true);
	assert.equal(snapshot.revision, 7);
	assert.deepEqual(snapshot.routes, [
		{ id: "alpha", name: "Alpha", endpoint: SITE, enabled: false, minBytes: 1024 },
		{ id: "beta", name: "Beta", endpoint: SITE, enabled: true, minBytes: 4096 }
	]);
});

test("writes path-addressed ops with the revision it read", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const { ctl } = harness.registration.options.inject();

	await ctl.write("alpha", { enabled: true, minBytes: 2048 }, 7);
	assert.deepEqual(harness.ctx.writes, [{
		ns: "llm-request-gzip",
		ops: [
			{ op: "set", path: ["providers", "alpha", "enabled"], value: true },
			{ op: "set", path: ["providers", "alpha", "minBytes"], value: 2048 }
		],
		revision: 7
	}]);
});

test("surfaces a refused write instead of reporting success", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const { ctl } = harness.registration.options.inject();
	harness.ctx.remote.settings.mutate = async () => ({ ok: false, error: { message: "stale revision" } });
	await assert.rejects(() => ctl.write("alpha", { enabled: true }, 3), /stale revision/u);
});
