/**
 * Contract test for the browser half.
 *
 * The bundle is plain JavaScript loaded through `window.__ModuleLoader__.load`,
 * so it can be executed directly under Node with a stubbed loader and a stubbed
 * `react`. This pins the things that fail silently in the browser: the bundle id
 * agreeing with the package name the Host resolves, the card landing on the
 * `settings.plugin.item` key the Plugins page dispatches, the card being
 * collapsed until asked, and the timing view appearing only while its
 * preference is on.
 *
 * The React stub tracks hooks, so a component can be rendered, clicked and
 * re-rendered without a reconciler.
 *
 * Run: node --test test/
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const PACKAGE_NAME = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name;
const NS = "llm-request-gzip";
const SITE = "https://gateway.example/v1";

//#region minimal React

/** One hook store shared by every render in a scenario; `mount` starts a new one. */
const hooks = [];
let hookCursor = 0;

const ReactStub = {
	// Render children the way React does: an array passed as one child is a list
	// of children, not a single nested child.
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
	useState(initial) {
		const index = hookCursor++;
		if (!(index in hooks)) hooks[index] = initial;
		return [hooks[index], (next) => {
			hooks[index] = typeof next === "function" ? next(hooks[index]) : next;
		}];
	},
	// Run effects immediately: these components read on mount, and the test
	// flushes the microtask queue before re-rendering. TimingView is never
	// mounted here, so no real interval is ever created.
	useEffect(fn) {
		fn();
	},
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useRef: (initial) => ({ current: initial })
};

/** Render one component with fresh hooks and return its element tree. */
function mount(component, props) {
	hooks.length = 0;
	hookCursor = 0;
	return component(props);
}

/** Re-render the same component without clearing hooks, as a state update would. */
function rerender(component, props) {
	hookCursor = 0;
	return component(props);
}

//#endregion

/** Let pending promises settle, so a mount-time read can publish its result. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Run `body` with timers stubbed out. The timing view polls while mounted, and
 * the React stand-in runs effects synchronously, so without this a real
 * interval would outlive the test and keep the process alive.
 */
function withoutTimers(body) {
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	globalThis.setInterval = () => 0;
	globalThis.clearInterval = () => {};
	try {
		return body();
	} finally {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	}
}

/** Execute the bundle against a stubbed loader and return its module exports. */
function loadBundle() {
	hooks.length = 0;
	hookCursor = 0;
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

/** A fake client context recording slot registrations, plus a controllable settings scope. */
function createClientContext(sectionValue = { providers: { beta: { enabled: true, minBytes: 4096 } }, timing: true }) {
	const harness = { registrations: [] };
	const listeners = new Set();
	let snapshot = { status: "ready", value: sectionValue, writable: true, revision: 7 };

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
								{ ns: NS, applies: "live", revision: 7, secrets: [], value: sectionValue },
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
		injected: [],
		slots: {
			inject(key, callback) {
				ctx.injected.push(key);
				callback();
				return () => {};
			},
			register(options, component) {
				const entry = { options, component };
				harness.registrations.push(entry);
				return () => {
					const index = harness.registrations.indexOf(entry);
					if (index !== -1) harness.registrations.splice(index, 1);
				};
			}
		}
	};

	ctx.settingsScope = {
		bind() {
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				}
			};
		}
	};

	/** Replace the section the scope reports, and notify subscribers. */
	harness.publish = (next) => {
		snapshot = { ...snapshot, ...next };
		for (const listener of [...listeners]) listener();
	};
	harness.listenerCount = () => listeners.size;
	harness.registrationFor = (name) => harness.registrations.find((entry) => entry.options.name === name);
	return Object.assign(harness, { ctx });
}

test("the bundle id matches the package name the Host resolves", () => {
	const { entry } = loadBundle();
	assert.equal(entry.id, PACKAGE_NAME, "client-modules keys the graph by package name");
});

test("registers the card on the namespace key the Plugins page dispatches", () => {
	const { exports } = loadBundle();
	assert.equal(typeof exports.apply, "function");
	assert.deepEqual([...exports.inject], ["slots", "remote", "remote.settings", "remote.llm", "settingsScope"]);

	const harness = createClientContext();
	exports.apply(harness.ctx);
	const registration = harness.registrationFor("settings.plugin.item");
	assert.equal(registration.options.key, NS, "the key must equal the served settings namespace");
	assert.equal(typeof registration.options.inject().ctl.read, "function");
});

test("the settings card starts collapsed and expands on click", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const card = harness.registrationFor("settings.plugin.item");
	const { ctl } = card.options.inject();

	const collapsed = mount(card.component, { ctl });
	await flush();
	assert.equal(collapsed.type, "li", "the card is a list item, like every shipped card");
	const [header, body] = collapsed.children;
	assert.equal(header.type, "button");
	assert.equal(header.props["aria-expanded"], false, "collapsed by default");
	assert.match(header.props["aria-label"], /展开/u);
	assert.equal(body, null, "the body is not rendered while collapsed");
	assert.equal(header.children[0].children[0].children[0], "模型请求 gzip 与耗时");

	header.props.onClick();
	const expanded = rerender(card.component, { ctl });
	assert.equal(expanded.children[0].props["aria-expanded"], true);
	assert.ok(expanded.children[1] !== null, "the body renders once open");
	assert.match(expanded.children[0].props["aria-label"], /收起/u);
});

test("the card offers the timing switch and writes it as a top-level field", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext({ providers: {}, timing: false });
	exports.apply(harness.ctx);
	const card = harness.registrationFor("settings.plugin.item");
	const { ctl } = card.options.inject();

	const collapsed = mount(card.component, { ctl });
	await flush();
	collapsed.children[0].props.onClick();
	const body = rerender(card.component, { ctl }).children[1];
	const timingRow = body.children.find((child) => child !== null && child.type === "label");
	assert.ok(timingRow !== undefined, "the timing preference is offered");
	const checkbox = timingRow.children[0];
	assert.equal(checkbox.props.checked, false, "it reflects the stored section");

	await checkbox.props.onChange({ target: { checked: true } });
	assert.deepEqual(harness.ctx.writes, [{ ns: NS, ops: [{ op: "set", path: ["timing"], value: true }], revision: 7 }]);
});

test("reads the timing preference, defaulting to on when unset", async () => {
	const { exports } = loadBundle();
	const on = createClientContext({ providers: {} });
	exports.apply(on.ctx);
	assert.equal((await on.registrationFor("settings.plugin.item").options.inject().ctl.read()).timing, true);

	const off = createClientContext({ providers: {}, timing: false });
	exports.apply(off.ctx);
	assert.equal((await off.registrationFor("settings.plugin.item").options.inject().ctl.read()).timing, false);
});

test("joins the provider directory with the stored policy and both profile shapes", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const { ctl } = harness.registrationFor("settings.plugin.item").options.inject();

	const snapshot = await ctl.read();
	assert.equal(snapshot.revision, 7);
	assert.deepEqual(snapshot.routes, [
		{ id: "alpha", name: "Alpha", endpoint: SITE, enabled: false, minBytes: 1024 },
		{ id: "beta", name: "Beta", endpoint: SITE, enabled: true, minBytes: 4096 }
	]);
});

test("writes path-addressed provider ops with the revision it read", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const { ctl } = harness.registrationFor("settings.plugin.item").options.inject();

	await ctl.write("alpha", { enabled: true, minBytes: 2048 }, 7);
	assert.deepEqual(harness.ctx.writes, [{
		ns: NS,
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
	const { ctl } = harness.registrationFor("settings.plugin.item").options.inject();
	harness.ctx.remote.settings.mutate = async () => ({ ok: false, error: { message: "stale revision" } });
	await assert.rejects(() => ctl.write("alpha", { enabled: true }, 3), /stale revision/u);
});

test("registers the timing view while the preference is on", () => {
	const { exports } = loadBundle();
	const harness = createClientContext({ providers: {}, timing: true });
	exports.apply(harness.ctx);

	const view = harness.registrationFor("conversation.view");
	assert.ok(view !== undefined, "the view is registered");
	assert.equal(view.options.id, "request-timing", "a fresh id adds a tab rather than replacing the shipped Trajectory");
	assert.ok(view.options.order > 10, "it renders after the Trajectory, which registers at order 10");
	assert.equal(view.options.label(), "请求耗时");
	assert.equal(typeof view.options.inject().loadTimings, "function");
	assert.equal(harness.listenerCount(), 1, "the plugin observes the settings scope");
});

test("does not register the view while the preference is off", () => {
	const { exports } = loadBundle();
	const harness = createClientContext({ providers: {}, timing: false });
	exports.apply(harness.ctx);
	assert.equal(harness.registrationFor("conversation.view"), undefined);
});

test("waits for the first section, so a disabled view never flashes", () => {
	const { exports } = loadBundle();
	const pending = createClientContext({ providers: {} });
	pending.ctx.settingsScope.bind = () => ({
		getSnapshot: () => ({ status: "loading", value: undefined, writable: false, revision: undefined }),
		subscribe: () => () => {}
	});
	exports.apply(pending.ctx);
	assert.equal(pending.registrationFor("conversation.view"), undefined, "no tab until the section is known");
});

test("still offers the view when settings are unavailable", () => {
	const { exports } = loadBundle();
	const harness = createClientContext({ providers: {} });
	harness.ctx.settingsScope.bind = () => ({
		getSnapshot: () => ({ status: "unavailable", value: undefined, writable: false, revision: undefined }),
		subscribe: () => () => {}
	});
	exports.apply(harness.ctx);
	assert.ok(harness.registrationFor("conversation.view") !== undefined, "the default is on");
});

test("adds and removes the view as the preference changes", () => {
	const { exports } = loadBundle();
	const harness = createClientContext({ providers: {}, timing: true });
	exports.apply(harness.ctx);
	assert.ok(harness.registrationFor("conversation.view") !== undefined);

	harness.publish({ value: { providers: {}, timing: false } });
	assert.equal(harness.registrationFor("conversation.view"), undefined, "switching off removes the tab");

	harness.publish({ value: { providers: {}, timing: true } });
	assert.ok(harness.registrationFor("conversation.view") !== undefined, "switching back on restores it");
});

test("reads the timing ledger over the same-origin API route", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const { loadTimings } = harness.registrationFor("conversation.view").options.inject();

	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return Response.json({ measurements: [{ id: 1, sendMs: 12 }] });
	};
	try {
		assert.deepEqual(await loadTimings("session-1"), [{ id: 1, sendMs: 12 }]);
		assert.equal(calls[0].url, "/api/llm-request-gzip/timings?sessionId=session-1", "same-origin, so the browser session cookie rides along");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("surfaces an unavailable ledger instead of reporting it empty", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const { loadTimings } = harness.registrationFor("conversation.view").options.inject();

	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
	try {
		await assert.rejects(() => loadTimings("session-1"), /HTTP 401/u);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("tolerates a ledger answer that carries no measurements", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const { loadTimings } = harness.registrationFor("conversation.view").options.inject();

	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({});
	try {
		assert.deepEqual(await loadTimings(undefined), [], "a request without a session still reads as an empty ledger");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("renders the timing columns, the sizes and the compression delta", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const view = harness.registrationFor("conversation.view");
	const injected = view.options.inject();
	const measurements = [{
		id: 1,
		sessionId: "s1",
		provider: "sg",
		model: "deepseek-flash",
		purpose: null,
		status: "complete",
		startedAt: 1700000000000,
		prepareMs: 20,
		sendMs: 30,
		serverMs: 900,
		ttftMs: 950,
		generationMs: 2000,
		totalMs: 3000,
		inputTokens: 10,
		outputTokens: 500,
		tokensPerSecond: 250,
		requestBytes: 1400000,
		sentBytes: 400000,
		responseBytes: 12345,
		compressed: true,
		attempts: 1
	}];
	const props = { ...injected, sessionId: "s1", loadTimings: async () => measurements };
	withoutTimers(() => mount(view.component, props));
	await flush();
	const tree = withoutTimers(() => rerender(view.component, props));

	const labels = [];
	const texts = [];
	const walk = (node) => {
		if (node === null || node === undefined || typeof node !== "object") {
			texts.push(node);
			return;
		}
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (node.type === "th") labels.push(node.children[0]);
		walk(node.children);
	};
	walk(tree);

	assert.deepEqual(labels, ["时间", "提供方 / 模型", "发送", "服务端", "首 token", "生成", "tok/s", "请求体", "响应体", "总计"]);
	assert.ok(texts.includes("1.34MB→390.6KB"), `expected the compression delta, got ${JSON.stringify(texts.filter((t) => typeof t === "string"))}`);
	assert.ok(texts.includes("12.1KB"), "expected the response size");
	assert.ok(texts.includes("900ms"), "expected the server phase");
});

test("covers the shell's column-width handles so the panel cannot be dragged wider", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const view = harness.registrationFor("conversation.view");
	const props = { ...view.options.inject(), sessionId: "s1", loadTimings: async () => [] };
	withoutTimers(() => mount(view.component, props));
	await flush();
	const tree = withoutTimers(() => rerender(view.component, props));

	const shields = tree.children.filter((child) => child !== null && typeof child === "object" && child.props["data-handle-shield"] !== undefined);
	assert.deepEqual(shields.map((shield) => shield.props["data-handle-shield"]), ["left", "right"]);
	for (const shield of shields) {
		assert.equal(shield.props["aria-hidden"], "true", "decoration only");
		assert.equal(shield.props.style.position, "absolute");
		assert.ok(shield.props.style.zIndex > 8, "above the shell handle, which sits at z-index 8");
	}
	assert.ok(shields[0].props.style.right !== undefined && shields[0].props.style.left === undefined, "the left band is anchored from the right edge");
	assert.ok(shields[1].props.style.left !== undefined && shields[1].props.style.right === undefined, "the right band is anchored from the left edge");
	assert.match(String(shields[0].props.style.right), /--dsh-chat-content-width/u, "positioned by the same axis the shell handle uses");
});
