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
 * Run: npm test (from the package root; the script lists every suite)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const PACKAGE_NAME = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name;
const NS = "model-request-accelerator";
const SITE = "https://gateway.example/v1";

//#region minimal React

/** One hook store shared by every render in a scenario; `mount` starts a new one. */
const hooks = [];
let hookCursor = 0;
/** Effects collected during a render, run after the commit the way React runs them. */
let pendingEffects = [];
/** Cleanups returned by the effects of the current mount. */
let effectCleanups = [];
/** Every `scrollIntoView` the component asked for, with its options. */
const scrollCalls = [];

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
	useEffect(fn) {
		pendingEffects.push(fn);
	},
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useRef: (initial) => ({ current: initial })
};

/** Attach refs the way React does at commit time, so terminal nodes exist before effects run. */
function commitRefs(node) {
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) commitRefs(child);
		return;
	}
	const ref = node.props?.ref;
	if (ref !== null && ref !== undefined && typeof ref === "object" && "current" in ref) {
		ref.current = {
			scrollIntoView: (options) => scrollCalls.push(options),
			getBoundingClientRect: () => ({ top: 100 }),
			remove: () => {}
		};
	}
	commitRefs(node.children);
}

/** Render one component with fresh hooks, commit it, then run its effects. */
function mount(component, props) {
	hooks.length = 0;
	hookCursor = 0;
	pendingEffects = [];
	effectCleanups = [];
	const tree = component(props);
	commitRefs(tree);
	for (const effect of pendingEffects) {
		const cleanup = effect();
		if (typeof cleanup === "function") effectCleanups.push(cleanup);
	}
	return tree;
}

/**
 * Re-render the same component without clearing hooks. Effects are not re-run:
 * every effect under test declares empty dependencies, so React would not re-run
 * them either.
 */
function rerender(component, props) {
	hookCursor = 0;
	pendingEffects = [];
	return component(props);
}

/** Unmount the current render, running the effects' cleanups. */
function unmount() {
	for (const cleanup of effectCleanups.splice(0)) cleanup();
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
function createClientContext(sectionValue = { providers: { beta: { enabled: true, minBytes: 4096, prewarm: true } }, timing: true, prewarmPoolSize: 3, encoding: "auto" }) {
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
	assert.equal(header.children[0].children[0].children[0], "模型请求加速");

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

	/** Depth-first search for the first element matching `match`. */
	const find = (node, match) => {
		if (node === null || typeof node !== "object") return undefined;
		if (Array.isArray(node)) {
			for (const child of node) {
				const hit = find(child, match);
				if (hit !== undefined) return hit;
			}
			return undefined;
		}
		if (match(node)) return node;
		return find(node.children, match);
	};

	// The switch sits inside the settings grid, so it is found by shape rather
	// than by position.
	const timingRow = find(body, (node) => node.type === "label" && find(node.children, (inner) => inner.type === "input") !== undefined);
	assert.ok(timingRow !== undefined, "the timing preference is offered");
	const checkbox = find(timingRow.children, (node) => node.type === "input");
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
	assert.equal(snapshot.prewarmPoolSize, 3, "the pool size is read for the panel");
	assert.deepEqual(snapshot.routes, [
		{ id: "alpha", name: "Alpha", endpoint: SITE, enabled: false, minBytes: 1024, prewarm: false },
		{ id: "beta", name: "Beta", endpoint: SITE, enabled: true, minBytes: 4096, prewarm: true }
	]);
});

test("writes the pool size as a top-level field", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const { ctl } = harness.registrationFor("settings.plugin.item").options.inject();

	await ctl.write("prewarmPoolSize", { value: 5 }, 7);
	assert.deepEqual(harness.ctx.writes, [{ ns: NS, ops: [{ op: "set", path: ["prewarmPoolSize"], value: 5 }], revision: 7 }]);
});

test("writes path-addressed provider ops with the revision it read", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const { ctl } = harness.registrationFor("settings.plugin.item").options.inject();

	await ctl.write("alpha", { enabled: true, minBytes: 2048, prewarm: true }, 7);
	assert.deepEqual(harness.ctx.writes, [{
		ns: NS,
		ops: [
			{ op: "set", path: ["providers", "alpha", "enabled"], value: true },
			{ op: "set", path: ["providers", "alpha", "minBytes"], value: 2048 },
			{ op: "set", path: ["providers", "alpha", "prewarm"], value: true }
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
		assert.equal(calls[0].url, "/api/model-request-accelerator/timings?sessionId=session-1", "same-origin, so the browser session cookie rides along");
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

/** One complete measurement row, as the Host route would return it. */
function measurement() {
	return {
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
		cacheReadTokens: 900,
		cacheWriteTokens: 0,
		cacheHitPercent: 90,
		toFirstTokenMs: 950,
		prewarm: { prefixBytes: 400000, deltaBytes: 1200, holdMs: 2400 },
		prewarmMiss: null,
		requestBytes: 1400000,
		sentBytes: 400000,
		responseBytes: 12345,
		compressed: true,
		attempts: 1
	};
}

test("renders the timing columns, the sizes and the compression delta", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const view = harness.registrationFor("conversation.view");
	const injected = view.options.inject();
	const measurements = [measurement()];
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

	assert.deepEqual(labels, ["时间", "提供方 / 模型", "发送", "服务端", "首token", "生成", "tok/s", "缓存", "请求体", "响应体", "总计"]);
	assert.ok(texts.includes("950ms"), "the wait from claim to first token is shown");
	assert.ok(texts.includes("90.0%"), "the prefix-cache hit rate is shown per request");
	assert.ok(texts.includes("预热"), "a pre-transmitted request is marked as such");
	assert.ok(texts.includes("1.34MB→390.6KB"), `expected the compression delta, got ${JSON.stringify(texts.filter((t) => typeof t === "string"))}`);
	assert.ok(texts.includes("12.1KB"), "expected the response size");
	assert.ok(texts.includes("900ms"), "expected the server phase");
});

test("takes the shell's column-width handles out of the layout while mounted", async () => {
	const appended = [];
	globalThis.document = {
		createElement: (tagName) => ({
			tagName,
			textContent: "",
			remove() {
				const index = appended.indexOf(this);
				if (index !== -1) appended.splice(index, 1);
			}
		}),
		head: { appendChild: (element) => appended.push(element) }
	};
	try {
		const { exports } = loadBundle();
		const harness = createClientContext();
		exports.apply(harness.ctx);
		const view = harness.registrationFor("conversation.view");
		const props = { ...view.options.inject(), sessionId: "s1", loadTimings: async () => [] };
		withoutTimers(() => mount(view.component, props));

		assert.equal(appended.length, 1, "one stylesheet is installed on mount");
		assert.equal(appended[0].tagName, "style");
		assert.match(appended[0].textContent, /\[data-width-handle\]\{display:none/u, "the handle is hidden, not covered");
		assert.match(appended[0].textContent, /!important/u);

		withoutTimers(() => unmount());
		assert.equal(appended.length, 0, "the stylesheet is removed with the view, restoring the handle");
	} finally {
		delete globalThis.document;
	}
});

test("bounds the panel to one screen, so there is no second scrollbar", async () => {
	globalThis.window = { innerHeight: 900, addEventListener: () => {}, removeEventListener: () => {} };
	try {
		const { exports } = loadBundle();
		const harness = createClientContext();
		exports.apply(harness.ctx);
		const view = harness.registrationFor("conversation.view");
		const props = { ...view.options.inject(), sessionId: "s1", loadTimings: async () => [measurement()] };
		withoutTimers(() => mount(view.component, props));
		await flush();
		const tree = withoutTimers(() => rerender(view.component, props));

		const collect = (node, found = []) => {
			if (node === null || typeof node !== "object") return found;
			if (Array.isArray(node)) {
				for (const child of node) collect(child, found);
				return found;
			}
			if (node.type === "table") found.push(node);
			collect(node.children, found);
			return found;
		};
		const [table] = collect(tree);
		const wrapper = tree.children.find((child) => child !== null && typeof child === "object" && child.children?.some?.((inner) => inner === table));
		assert.ok(wrapper !== undefined, "the table sits in its own scrolling wrapper");
		assert.equal(wrapper.props.style.overflow, "auto");
		assert.equal(wrapper.props.style.minHeight, 0, "the wrapper shrinks inside the bounded panel");

		// 900px of window, minus the panel top at 100px, minus the shell's 152px
		// composer reserve and the 16px bottom margin.
		assert.equal(tree.props.style.maxHeight, 632, "the panel is bounded to the space actually left below it");
	} finally {
		delete globalThis.window;
	}
});

test("starts at the top when the view is opened", () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const view = harness.registrationFor("conversation.view");
	const props = { ...view.options.inject(), sessionId: "s1", loadTimings: async () => [] };
	scrollCalls.length = 0;
	withoutTimers(() => mount(view.component, props));

	assert.equal(scrollCalls.length, 1, "the panel asks to be revealed once");
	assert.equal(scrollCalls[0].block, "start", "aligned to the top, not the bottom the transcript was left at");
	assert.equal(scrollCalls[0].inline, "nearest", "without disturbing the horizontal axis");
});
;

test("fills the panel by proportional column shares instead of by content", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const view = harness.registrationFor("conversation.view");
	const props = { ...view.options.inject(), sessionId: "s1", loadTimings: async () => [measurement()] };
	withoutTimers(() => mount(view.component, props));
	await flush();
	const tree = withoutTimers(() => rerender(view.component, props));

	const collect = (node, type, found = []) => {
		if (node === null || typeof node !== "object") return found;
		if (Array.isArray(node)) {
			for (const child of node) collect(child, type, found);
			return found;
		}
		if (node.type === type) found.push(node);
		collect(node.children, type, found);
		return found;
	};

	const [table] = collect(tree, "table");
	assert.equal(table.props.style.width, "100%", "the table spans the panel");
	assert.equal(table.props.style.tableLayout, "fixed", "shares, not content, decide the widths");

	const [colgroup] = collect(tree, "colgroup");
	const shares = colgroup.children.map((col) => Number.parseFloat(col.props.style.width));
	assert.equal(shares.length, 11, "one share per column");
	assert.equal(Math.round(shares.reduce((sum, share) => sum + share, 0)), 100, "the shares exhaust the width");
	assert.ok(Math.max(...shares) <= 30, "no column is handed a runaway share");
});

test("marks a row that had a pool but could not use it", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const view = harness.registrationFor("conversation.view");
	const props = {
		...view.options.inject(),
		sessionId: "s1",
		loadTimings: async () => [{ ...measurement(), prewarm: null, prewarmMiss: "mismatch" }]
	};
	withoutTimers(() => mount(view.component, props));
	await flush();
	const tree = withoutTimers(() => rerender(view.component, props));

	const chips = [];
	const walk = (node) => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (typeof node.children?.[0] === "string" && node.children[0].startsWith("预热")) chips.push(node);
		walk(node.children);
	};
	walk(tree);
	const missChip = chips.find((chip) => chip.children[0] === "预热✗");
	assert.ok(missChip !== undefined, "the row says the pool was there but unusable");
	assert.match(String(missChip.props.title), /历史在两次请求之间被改写了/u, "and the tooltip gives the reason");
});

test("shows a dash, not 0B, when a response was never attributed", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const view = harness.registrationFor("conversation.view");
	const props = {
		...view.options.inject(),
		sessionId: "s1",
		loadTimings: async () => [{ ...measurement(), responseBytes: null }]
	};
	withoutTimers(() => mount(view.component, props));
	await flush();
	const tree = withoutTimers(() => rerender(view.component, props));

	const texts = [];
	const walk = (node) => {
		if (node === null || typeof node !== "object") {
			texts.push(node);
			return;
		}
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		walk(node.children);
	};
	walk(tree);
	assert.ok(texts.includes("–"), "the response column reports the missing attribution");
	assert.ok(!texts.includes("0B"), "and never claims a zero-byte response");
});

test("holds the headings and every provider in one grid", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const card = harness.registrationFor("settings.plugin.item");
	const { ctl } = card.options.inject();
	const collapsed = mount(card.component, { ctl });
	await flush();
	collapsed.children[0].props.onClick();
	const body = rerender(card.component, { ctl }).children[1];

	const collect = (node, predicate, found = []) => {
		if (node === null || typeof node !== "object") return found;
		if (Array.isArray(node)) {
			for (const child of node) collect(child, predicate, found);
			return found;
		}
		if (predicate(node)) found.push(node);
		collect(node.children, predicate, found);
		return found;
	};

	// Located by the headings it contains rather than by a width, so the layout can
	// change without the test losing the grid it is about.
	const grid = collect(body, (node) => Array.isArray(node.children) && node.children.some((child) => child?.props?.key === "h-name"))[0];
	assert.ok(grid !== undefined, "headings and rows share one grid");
	assert.deepEqual(grid.children.slice(0, 3).map((cell) => cell.children[0]), ["提供方", "压缩", "预传输"], "the provider leads, then its two switches");
	assert.ok(String(grid.props.style.gridTemplateColumns).includes("1fr"), "and the provider column takes the slack, so the table fills the panel");

	// Each route contributes the same three cells, in the same order, after a group
	// label that spans the grid (so it cannot disturb a column).
	const cells = grid.children.slice(3).filter((child) => child.type !== "div");
	const routes = (await ctl.read()).routes;
	assert.equal(cells.length, routes.length * 3, "three cells per route");
	for (let index = 0; index < cells.length; index += 3) {
		assert.deepEqual(cells.slice(index, index + 3).map((cell) => cell.type), ["span", "input", "input"], "identity, compress, pre-transmit");
	}
});

test("keeps the plugin-level controls next to their labels", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const card = harness.registrationFor("settings.plugin.item");
	const { ctl } = card.options.inject();
	const collapsed = mount(card.component, { ctl });
	await flush();
	collapsed.children[0].props.onClick();
	const body = rerender(card.component, { ctl }).children[1];

	const collect = (node, predicate, found = []) => {
		if (node === null || typeof node !== "object") return found;
		if (Array.isArray(node)) {
			for (const child of node) collect(child, predicate, found);
			return found;
		}
		if (predicate(node)) found.push(node);
		collect(node.children, predicate, found);
		return found;
	};

	const pool = collect(body, (node) => node.type === "input" && node.props.type === "number" && typeof node.props.title === "string" && node.props.title.includes("预发请求"))[0];
	assert.ok(pool !== undefined, "the pool field is offered");
	assert.equal(pool.props.style.marginLeft, undefined, "no control is pushed to the far edge");
	assert.equal(pool.props.style.justifySelf, undefined);

	const line = collect(body, (node) => Array.isArray(node.children) && node.children.includes(pool))[0];
	assert.ok(line !== undefined, "the field shares a line with its label");
	assert.ok(line.children.some((child) => child !== null && typeof child === "object" && child.children?.[0] === "预传输池大小"), "and the label is right beside it");
});

test("offers the request-body algorithm and writes it as a top-level field", async () => {
	const { exports } = loadBundle();
	const harness = createClientContext();
	exports.apply(harness.ctx);
	const card = harness.registrationFor("settings.plugin.item");
	const { ctl } = card.options.inject();

	assert.equal((await ctl.read()).encoding, "auto", "the stored algorithm is read for the panel");

	const collapsed = mount(card.component, { ctl });
	await flush();
	collapsed.children[0].props.onClick();
	const body = rerender(card.component, { ctl }).children[1];

	const select = (function find(node) {
		if (node === null || typeof node !== "object") return undefined;
		if (Array.isArray(node)) {
			for (const child of node) {
				const hit = find(child);
				if (hit !== undefined) return hit;
			}
			return undefined;
		}
		if (node.type === "select") return node;
		return find(node.children);
	})(body);
	assert.ok(select !== undefined, "the algorithm is offered");
	assert.deepEqual(select.children.map((option) => option.props.value), ["auto", "gzip"]);
	assert.equal(select.props.value, "auto", "and reflects the stored choice");

	await ctl.write("encoding", { value: "gzip" }, 7);
	assert.deepEqual(harness.ctx.writes, [{ ns: NS, ops: [{ op: "set", path: ["encoding"], value: "gzip" }], revision: 7 }]);
});
