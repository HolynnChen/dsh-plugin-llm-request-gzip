/**
 * Browser half: the "模型请求 gzip" card inside Settings > Plugins.
 *
 * The Plugins settings section dispatches `settings.plugin.item` by settings
 * namespace, so a card keyed by this plugin's namespace renders as soon as the
 * Host serves that namespace. Reads and writes go through the product's own
 * `remote.settings` and `remote.llm` namespaces — this package adds no wire of
 * its own.
 *
 * Written against the CJS factory contract of the client module system: plain
 * JavaScript only, no JSX and no ESM syntax.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-llm-request-gzip",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** The Host settings namespace this card edits. */
		const NS = "llm-request-gzip";
		/** Mirrors the Host default; used before a section value exists. */
		const DEFAULT_MIN_BYTES = 1024;

		/** Required services (cordis fiber inject). */
		const inject = ["slots", "remote", "remote.settings", "remote.llm"];

		//#region copy + styles

		const COPY = {
			title: "模型请求 gzip 压缩",
			intro:
				"响应侧 gzip 已由 Node 默认开启（undici 自动发送 accept-encoding 并解压），这里控制的是请求体压缩：对指定提供方使用 content-encoding: gzip 上传，适合长上下文与含图片的请求。",
			sharedEndpoint: "以下提供方共用同一 endpoint，因此开关会同时作用于它们：",
			loading: "正在读取设置…",
			retry: "重试",
			empty: "当前没有已注册的提供方路由。",
			unavailable: "设置当前不可写（只读或命名空间未就绪）。",
			advanced: "最小压缩体积（字节）",
			advancedHint: "低于该体积的请求保持原样。留空或失焦即保存。"
		};

		const S = {
			card: {
				border: "0.5px solid var(--dsw-alias-border-l4)",
				background: "var(--dsw-alias-bg-layer-3)",
				borderRadius: "16px",
				padding: "14px 16px",
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				color: "var(--dsw-alias-label-primary)"
			},
			title: { margin: 0, fontSize: "15px", fontWeight: 600, lineHeight: 1.4 },
			intro: { margin: 0, fontSize: "12.5px", lineHeight: "19px", color: "var(--dsw-alias-label-tertiary)" },
			group: {
				borderTop: "0.5px solid var(--dsw-alias-border-l2)",
				paddingTop: "10px",
				display: "flex",
				flexDirection: "column",
				gap: "8px"
			},
			groupNote: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-warn-label)" },
			row: {
				display: "flex",
				alignItems: "center",
				gap: "10px",
				flexWrap: "wrap"
			},
			toggleRow: { display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer", minWidth: "180px" },
			routeName: { fontSize: "14px", fontWeight: 500, lineHeight: "22px" },
			mono: { fontFamily: "var(--ds-font-family-code)", fontSize: "11.5px", color: "var(--dsw-alias-label-tertiary)" },
			endpoint: { fontFamily: "var(--ds-font-family-code)", fontSize: "11.5px", color: "var(--dsw-alias-label-tertiary)" },
			field: { display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "auto" },
			label: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
			input: {
				boxSizing: "border-box",
				border: "0.5px solid var(--dsw-alias-border-l4)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)",
				borderRadius: "8px",
				height: "28px",
				width: "96px",
				padding: "0 8px",
				font: "inherit",
				fontSize: "12px"
			},
			notice: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-success-primary)" },
			error: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-error-primary)" },
			muted: { margin: 0, fontSize: "12.5px", lineHeight: "19px", color: "var(--dsw-alias-label-tertiary)" },
			button: {
				border: "0.5px solid var(--dsw-alias-border-l3)",
				background: "transparent",
				color: "var(--dsw-alias-label-primary)",
				borderRadius: "14px",
				height: "28px",
				padding: "0 10px",
				font: "inherit",
				fontSize: "12px",
				cursor: "pointer",
				alignSelf: "flex-start"
			}
		};

		//#endregion
		//#region pure helpers

		/** Read a failure's message without assuming it is an `Error`. */
		function messageOf(error) {
			if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message;
			return String(error);
		}

		/** Drop trailing slashes so a stored endpoint reads as a stable prefix. */
		function normalizeEndpoint(baseURL) {
			if (typeof baseURL !== "string") return undefined;
			const trimmed = baseURL.trim();
			if (trimmed.length === 0) return undefined;
			return trimmed.replace(/\/+$/u, "");
		}

		/** Walk a configurable-provider `settingsPath` into a namespace value. */
		function walkPath(value, path) {
			let node = value;
			for (const segment of path) {
				if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
				node = node[segment];
			}
			return node;
		}

		/** The endpoint a provider profile declares, when it declares one. */
		function endpointOf(namespaceValue, settingsPath) {
			const profile = walkPath(namespaceValue, settingsPath);
			if (profile === null || typeof profile !== "object" || Array.isArray(profile)) return undefined;
			return normalizeEndpoint(profile.baseURL);
		}

		/** Compile this namespace's stored section into `route -> policy`. */
		function policiesOf(view) {
			const policies = new Map();
			if (view === undefined) return policies;
			const providers = walkPath(view.value, ["providers"]);
			if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return policies;
			for (const route of Object.keys(providers)) {
				const entry = providers[route];
				if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
				policies.set(route, {
					enabled: entry.enabled === true,
					minBytes: Number.isFinite(entry.minBytes) && entry.minBytes >= 0 ? entry.minBytes : DEFAULT_MIN_BYTES
				});
			}
			return policies;
		}

		/**
		 * Group routes by endpoint so a shared gateway renders as one block: on a
		 * shared endpoint a single enabled route compresses the traffic of every
		 * route that owns it, and the UI must say so rather than imply otherwise.
		 */
		function groupRoutes(routes) {
			const groups = [];
			const byEndpoint = new Map();
			for (const route of routes) {
				const key = route.endpoint === null ? "\u0000none" : route.endpoint;
				let group = byEndpoint.get(key);
				if (group === undefined) {
					group = { endpoint: route.endpoint, routes: [] };
					byEndpoint.set(key, group);
					groups.push(group);
				}
				group.routes.push(route);
			}
			return groups;
		}

		//#endregion
		//#region data access

		/**
		 * Thin read/write face over the product's remote namespaces.
		 * @param ctx - browser plugin context.
		 * @returns snapshot reads and per-route writes.
		 */
		function createController(ctx) {
			const settings = ctx.remote.settings;
			const llm = ctx.remote.llm;

			/** Join the provider directory with this namespace's stored value. */
			async function read() {
				const [described, registered, declared] = await Promise.all([
					settings.describe(),
					llm.listProviders(),
					llm.listConfigurableProviders()
				]);
				if (!described.ok) throw new Error(described.error.message);
				if (!registered.ok) throw new Error(registered.error.message);
				if (!declared.ok) throw new Error(declared.error.message);
				const document = described.value;
				const namespaces = new Map(document.namespaces.map((view) => [view.ns, view]));
				const own = namespaces.get(NS);
				const policies = policiesOf(own);
				const directory = new Map(declared.value.map((entry) => [entry.provider, entry]));
				const routes = registered.value.map((provider) => {
					const entry = directory.get(provider.id);
					const view = entry === undefined ? undefined : namespaces.get(entry.settingsNs);
					const endpoint = entry === undefined || view === undefined ? undefined : endpointOf(view.value, entry.settingsPath);
					const policy = policies.get(provider.id);
					return {
						id: provider.id,
						name: provider.name,
						endpoint: endpoint === undefined ? null : endpoint,
						enabled: policy !== undefined && policy.enabled,
						minBytes: policy === undefined ? DEFAULT_MIN_BYTES : policy.minBytes
					};
				});
				return {
					writable: document.writable === true && own !== undefined,
					revision: own === undefined ? null : own.revision,
					routes
				};
			}

			/**
			 * Persist one route's policy. Both fields are path-addressed so a
			 * concurrent edit elsewhere in the section is never overwritten.
			 */
			async function write(route, patch, revision) {
				const ops = [];
				if (typeof patch.enabled === "boolean") ops.push({ op: "set", path: ["providers", route, "enabled"], value: patch.enabled });
				if (typeof patch.minBytes === "number" && Number.isFinite(patch.minBytes)) ops.push({ op: "set", path: ["providers", route, "minBytes"], value: patch.minBytes });
				if (ops.length === 0) return;
				const answer = await settings.mutate(NS, ops, revision === null ? undefined : revision);
				if (!answer.ok) throw new Error(answer.error.message);
			}

			return { read, write };
		}

		//#endregion
		//#region card component

		/** One route row: the gzip switch plus its size threshold. */
		function RouteRow(props) {
			const h = React.createElement;
			const route = props.route;
			const busy = props.busy;
			const writable = props.writable;
			const onToggle = props.onToggle;
			const onThreshold = props.onThreshold;
			const onFocus = React.useCallback((event) => event.target.select(), []);
			const onKeyDown = React.useCallback((event) => {
				if (event.key === "Enter") event.target.blur();
			}, []);
			const onBlur = React.useCallback((event) => {
				const parsed = Number.parseInt(event.target.value, 10);
				if (!Number.isFinite(parsed) || parsed < 0) {
					event.target.value = String(route.minBytes);
					return;
				}
				if (parsed === route.minBytes) return;
				onThreshold(route.id, parsed);
			}, [route.id, route.minBytes, onThreshold]);
			return h("div", { style: S.row },
				h("label", { style: S.toggleRow },
					h("input", {
						type: "checkbox",
						checked: route.enabled,
						disabled: !writable || busy,
						onChange: (event) => onToggle(route.id, event.target.checked)
					}),
					h("span", { style: S.routeName }, route.name),
					h("span", { style: S.mono }, route.id)
				),
				h("span", { style: S.field },
					h("span", { style: S.label }, COPY.advanced),
					h("input", {
						key: `${route.id}:${String(route.minBytes)}`,
						type: "number",
						min: 0,
						step: 1,
						defaultValue: String(route.minBytes),
						disabled: !writable || busy || !route.enabled,
						style: { ...S.input, opacity: route.enabled ? 1 : 0.5 },
						title: COPY.advancedHint,
						onFocus,
						onKeyDown,
						onBlur
					})
				)
			);
		}

		/** The plugin card itself. */
		function GzipCard(props) {
			const h = React.createElement;
			const ctl = props.ctl;
			const [state, setState] = React.useState({ status: "loading", error: null, snapshot: null });
			const [busy, setBusy] = React.useState(null);
			const [notice, setNotice] = React.useState(null);

			const reload = React.useCallback(() => {
				let cancelled = false;
				setState((previous) => ({ ...previous, status: "loading", error: null }));
				ctl.read().then(
					(snapshot) => {
						if (!cancelled) setState({ status: "ready", error: null, snapshot });
					},
					(error) => {
						if (!cancelled) setState({ status: "error", error: messageOf(error), snapshot: null });
					}
				);
				return () => {
					cancelled = true;
				};
			}, [ctl]);

			React.useEffect(() => reload(), [reload]);

			const save = React.useCallback(async (route, patch) => {
				const snapshot = state.snapshot;
				if (snapshot === null || !snapshot.writable) return;
				setBusy(route);
				setNotice(null);
				try {
					await ctl.write(route, patch, snapshot.revision);
					setNotice(`${route} 已保存`);
					reload();
				} catch (error) {
					setState((previous) => ({ ...previous, error: messageOf(error) }));
				} finally {
					setBusy(null);
				}
			}, [ctl, state.snapshot, reload]);

			const onToggle = React.useCallback((route, enabled) => {
				save(route, { enabled });
			}, [save]);
			const onThreshold = React.useCallback((route, minBytes) => {
				save(route, { minBytes });
			}, [save]);

			const children = [h("h3", { key: "title", style: S.title }, COPY.title), h("p", { key: "intro", style: S.intro }, COPY.intro)];
			if (state.snapshot === null && state.status === "loading") children.push(h("p", { key: "loading", style: S.muted }, COPY.loading));
			if (state.error !== null) children.push(h("p", { key: "error", style: S.error }, state.error));
			if (state.snapshot === null) {
				if (state.status === "error") children.push(h("button", { key: "retry", type: "button", style: S.button, onClick: reload }, COPY.retry));
			} else {
				const snapshot = state.snapshot;
				if (!snapshot.writable) children.push(h("p", { key: "readonly", style: S.muted }, COPY.unavailable));
				if (snapshot.routes.length === 0) children.push(h("p", { key: "empty", style: S.muted }, COPY.empty));
				const groups = groupRoutes(snapshot.routes);
				groups.forEach((group, index) => {
					const block = [];
					if (group.endpoint !== null) block.push(h("span", { key: "endpoint", style: S.endpoint }, group.endpoint));
					if (group.routes.length > 1 && group.routes.some((route) => route.enabled)) block.push(h("p", { key: "note", style: S.groupNote }, COPY.sharedEndpoint));
					for (const route of group.routes) {
						block.push(h(RouteRow, {
							key: route.id,
							route,
							busy: busy === route.id,
							writable: snapshot.writable,
							onToggle,
							onThreshold
						}));
					}
					children.push(h("div", { key: `group-${String(index)}`, style: S.group }, block));
				});
				if (notice !== null) children.push(h("p", { key: "notice", style: S.notice }, notice));
			}
			return h("div", { style: S.card }, children);
		}

		//#endregion

		/**
		 * Mount the card into the Plugins settings section, keyed by this
		 * plugin's settings namespace.
		 * @param ctx - browser plugin context.
		 */
		function apply(ctx) {
			const ctl = createController(ctx);
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: NS,
				inject: () => ({ ctl })
			}, GzipCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
