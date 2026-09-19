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
		/** Mirrors the Host default for the pre-transmission pool. */
		const DEFAULT_POOL_SIZE = 3;

		/** Required services (cordis fiber inject). */
		const inject = ["slots", "remote", "remote.settings", "remote.llm", "settingsScope"];

		//#region copy + styles

		const COPY = {
			title: "模型请求 gzip 与耗时",
			description: "按提供方压缩请求体、预传输共享前缀，并展示请求耗时分解。",
			intro:
				"响应侧 gzip 已由 Node 默认开启（undici 自动发送 accept-encoding 并解压），这里控制的是请求体压缩：对指定提供方使用 content-encoding: gzip 上传，适合长上下文与含图片的请求。",
			timing: "展示「请求耗时」面板",
			timingHint: "在会话视图切换器里与「轨迹」并列。关闭后也不再记录耗时。",
			sharedEndpoint: "以下提供方共用同一 endpoint，因此开关会同时作用于它们：",
			loading: "正在读取设置…",
			retry: "重试",
			empty: "当前没有已注册的提供方路由。",
			unavailable: "设置当前不可写（只读或命名空间未就绪）。",
			advanced: "最小压缩体积（字节）",
			advancedHint: "低于该体积的请求保持原样。留空或失焦即保存。",
			prewarm: "预传输",
			prewarmHint: "上一步结束后就把下一请求的共享历史发出去，工具跑完时只补增量。需要中转站接受 chunked 请求体。",
			pool: "预传输池大小",
			poolHint: "每个会话同时保持几条预发请求。中转链路越长，越需要让被消费的那条提前在途。",
			expand: "展开",
			collapse: "收起"
		};

		const S = {
			card: {
				border: "0.5px solid var(--dsw-alias-border-l4)",
				background: "var(--dsw-alias-bg-layer-3)",
				borderRadius: "16px",
				listStyle: "none",
				transition: "border-color .16s, background .16s"
			},
			cardOpen: {
				background: "var(--dsw-alias-bg-layer-2)",
				borderColor: "var(--dsw-alias-label-dimmed)"
			},
			header: {
				appearance: "none",
				width: "100%",
				font: "inherit",
				color: "inherit",
				textAlign: "left",
				cursor: "pointer",
				background: "transparent",
				border: "0",
				borderRadius: "12px",
				alignItems: "center",
				gap: "12px",
				padding: "14px 16px",
				display: "flex"
			},
			headText: { flexDirection: "column", flex: 1, gap: "4px", minWidth: "0", display: "flex" },
			name: { fontSize: "15px", fontWeight: 600, lineHeight: 1.4, color: "var(--dsw-alias-label-primary)" },
			description: { fontSize: "13px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" },
			chevron: {
				flexShrink: 0,
				color: "var(--dsw-alias-label-tertiary)",
				transition: "transform .16s"
			},
			body: {
				borderTop: "0.5px solid var(--dsw-alias-border-l2)",
				margin: "0 16px",
				paddingBottom: "12px",
				flexDirection: "column",
				gap: "10px",
				display: "flex"
			},
			title: { margin: 0, fontSize: "15px", fontWeight: 600, lineHeight: 1.4 },
			intro: { margin: 0, fontSize: "12.5px", lineHeight: "19px", color: "var(--dsw-alias-label-tertiary)" },
			timingRow: {
				display: "flex",
				alignItems: "flex-start",
				gap: "8px",
				paddingTop: "12px",
				cursor: "pointer"
			},
			timingText: { flexDirection: "column", gap: "2px", display: "flex" },
			timingLabel: { fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" },
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
					minBytes: Number.isFinite(entry.minBytes) && entry.minBytes >= 0 ? entry.minBytes : DEFAULT_MIN_BYTES,
					prewarm: entry.prewarm === true
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
						minBytes: policy === undefined ? DEFAULT_MIN_BYTES : policy.minBytes,
						prewarm: policy !== undefined && policy.prewarm
					};
				});
				return {
					writable: document.writable === true && own !== undefined,
					revision: own === undefined ? null : own.revision,
					timing: own === undefined || own.value === null || typeof own.value !== "object" ? true : own.value.timing !== false,
					prewarmPoolSize: own === undefined || own.value === null || typeof own.value !== "object" || !Number.isFinite(own.value.prewarmPoolSize)
						? DEFAULT_POOL_SIZE
						: own.value.prewarmPoolSize,
					routes
				};
			}

			/**
			 * Persist one edit — a provider's policy, or the plugin-level timing
			 * switch. Every field is path-addressed, so a concurrent edit elsewhere
			 * in the section is never overwritten.
			 * @param target - a provider route, or the literal `timing`.
			 * @param patch - `{ enabled }` and/or `{ minBytes }`.
			 * @param revision - the revision the edit was read at.
			 */
			async function write(target, patch, revision) {
				const ops = [];
				if (target === "timing") {
					if (typeof patch.enabled === "boolean") ops.push({ op: "set", path: ["timing"], value: patch.enabled });
				} else if (target === "prewarmPoolSize") {
					if (typeof patch.value === "number" && Number.isFinite(patch.value) && patch.value >= 1) ops.push({ op: "set", path: ["prewarmPoolSize"], value: Math.floor(patch.value) });
				} else {
					if (typeof patch.enabled === "boolean") ops.push({ op: "set", path: ["providers", target, "enabled"], value: patch.enabled });
					if (typeof patch.minBytes === "number" && Number.isFinite(patch.minBytes)) ops.push({ op: "set", path: ["providers", target, "minBytes"], value: patch.minBytes });
					if (typeof patch.prewarm === "boolean") ops.push({ op: "set", path: ["providers", target, "prewarm"], value: patch.prewarm });
				}
				if (ops.length === 0) return;
				const answer = await settings.mutate(NS, ops, revision === null ? undefined : revision);
				if (!answer.ok) throw new Error(answer.error.message);
			}

			/**
			 * Read the timing ledger for one session. The Host route sits behind
			 * the product's own browser authentication, so a same-origin fetch
			 * carries the session cookie and needs no token of its own.
			 * @param sessionId - the conversation to read.
			 * @returns detached measurement rows, oldest first.
			 */
			async function loadTimings(sessionId) {
				const query = sessionId === undefined || sessionId === null ? "" : `?sessionId=${encodeURIComponent(String(sessionId))}`;
				const answer = await fetch(`/api/llm-request-gzip/timings${query}`, { headers: { accept: "application/json" } });
				if (!answer.ok) throw new Error(`timing ledger unavailable (HTTP ${answer.status})`);
				const payload = await answer.json();
				return payload !== null && typeof payload === "object" && Array.isArray(payload.measurements) ? payload.measurements : [];
			}

			return { read, write, loadTimings };
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
			const onPrewarm = props.onPrewarm;
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
				h("label", { style: { ...S.toggleRow, minWidth: 0 }, title: COPY.prewarmHint },
					h("input", {
						type: "checkbox",
						checked: route.prewarm,
						disabled: !writable || busy,
						onChange: (event) => onPrewarm(route.id, event.target.checked)
					}),
					h("span", { style: S.label }, COPY.prewarm)
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

		/** One chevron, rotated while the card is open. */
		function Chevron(props) {
			return React.createElement("svg", {
				width: 14,
				height: 14,
				viewBox: "0 0 14 14",
				fill: "none",
				"aria-hidden": "true",
				style: { ...S.chevron, transform: props.open ? "rotate(180deg)" : "none" }
			}, React.createElement("path", {
				d: "M3.5 5.5L7 9l3.5-3.5",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}

		/**
		 * The plugin card itself: a collapsed-by-default disclosure, the way every
		 * shipped card in this section behaves, so a settings page with several
		 * plugins stays scannable.
		 */
		function SettingsCard(props) {
			const h = React.createElement;
			const ctl = props.ctl;
			const [open, setOpen] = React.useState(false);
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

			const save = React.useCallback(async (target, patch) => {
				const snapshot = state.snapshot;
				if (snapshot === null || !snapshot.writable) return;
				setBusy(target);
				setNotice(null);
				try {
					await ctl.write(target, patch, snapshot.revision);
					setNotice(target === "timing" ? "请求耗时设置已保存" : target === "prewarmPoolSize" ? "预传输池大小已保存" : `${target} 已保存`);
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
			const onPrewarm = React.useCallback((route, prewarm) => {
				save(route, { prewarm });
			}, [save]);
			const onPool = React.useCallback((value) => {
				save("prewarmPoolSize", { value });
			}, [save]);
			const poolBlur = React.useCallback((event) => {
				const parsed = Number.parseInt(event.target.value, 10);
				if (!Number.isFinite(parsed) || parsed < 1) {
					event.target.value = String(state.snapshot === null ? DEFAULT_POOL_SIZE : state.snapshot.prewarmPoolSize);
					return;
				}
				if (state.snapshot !== null && parsed === state.snapshot.prewarmPoolSize) return;
				onPool(parsed);
			}, [onPool, state.snapshot]);

			const children = [];
			if (state.snapshot === null && state.status === "loading") children.push(h("p", { key: "loading", style: S.muted }, COPY.loading));
			if (state.error !== null) children.push(h("p", { key: "error", style: S.error }, state.error));
			if (state.snapshot === null) {
				if (state.status === "error") children.push(h("button", { key: "retry", type: "button", style: S.button, onClick: reload }, COPY.retry));
			} else {
				const snapshot = state.snapshot;
				children.push(h("p", { key: "intro", style: S.intro }, COPY.intro));
				if (!snapshot.writable) children.push(h("p", { key: "readonly", style: S.muted }, COPY.unavailable));
				children.push(h("label", { key: "timing", style: S.timingRow },
					h("input", {
						type: "checkbox",
						checked: snapshot.timing,
						disabled: !snapshot.writable || busy === "timing",
						onChange: (event) => save("timing", { enabled: event.target.checked })
					}),
					h("span", { style: S.timingText },
						h("span", { style: S.timingLabel }, COPY.timing),
						h("span", { style: S.muted }, COPY.timingHint)
					)
				));
				children.push(h("label", { key: "pool", style: { ...S.timingRow, paddingTop: 0 }, title: COPY.poolHint },
					h("span", { style: S.timingText },
						h("span", { style: S.timingLabel }, COPY.pool),
						h("span", { style: S.muted }, COPY.poolHint)
					),
					h("input", {
						key: `pool:${String(snapshot.prewarmPoolSize)}`,
						type: "number",
						min: 1,
						step: 1,
						defaultValue: String(snapshot.prewarmPoolSize),
						disabled: !snapshot.writable || busy === "prewarmPoolSize",
						style: { ...S.input, marginLeft: "auto" },
						onFocus: (event) => event.target.select(),
						onKeyDown: (event) => {
							if (event.key === "Enter") event.target.blur();
						},
						onBlur: poolBlur
					})
				));
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
							onThreshold,
							onPrewarm
						}));
					}
					children.push(h("div", { key: `group-${String(index)}`, style: S.group }, block));
				});
				if (notice !== null) children.push(h("p", { key: "notice", style: S.notice }, notice));
			}
			return h("li", { style: open ? { ...S.card, ...S.cardOpen } : S.card },
				h("button", {
					type: "button",
					style: S.header,
					"aria-expanded": open,
					"aria-label": `${open ? COPY.collapse : COPY.expand}: ${COPY.title}`,
					onClick: () => setOpen(!open)
				},
					h("span", { style: S.headText },
						h("span", { style: S.name }, COPY.title),
						h("span", { style: S.description }, COPY.description)
					),
					h(Chevron, { open })
				),
				open ? h("div", { style: S.body }, children) : null
			);
		}

		//#endregion
		//#region timing view

		/** Copy for the request-timing view. */
		const TIMING_COPY = {
			label: "请求耗时",
			intro: "按模型请求拆解耗时与体积。发送 = 请求体上传完毕；首 token = 发送完毕到首个 token；生成 = 首个 token 到结束，tok/s 按该区间计算。",
			loading: "正在读取…",
			empty: "本会话还没有模型请求记录。发起一次对话后这里会出现数据。",
			refresh: "刷新",
			requests: "请求数",
			latest: "最近一次",
			column: {
				time: "时间",
				route: "提供方 / 模型",
				send: "发送",
				server: "服务端",
				ttft: "首 token",
				generation: "生成",
				throughput: "tok/s",
				cache: "缓存",
				toFirstToken: "到首token",
				request: "请求体",
				response: "响应体",
				total: "总计"
			},
			hint: {
				time: "该请求发出的本地时刻",
				route: "提供方路由与模型；gzip 表示请求体确实被压缩过，预热表示这次请求复用了提前发出的历史",
				send: "发出请求 → 请求体全部发送完毕",
				server: "发送完毕 → 收到响应头",
				ttft: "发送完毕 → 首个 token",
				generation: "首个 token → 流结束；tok/s 按此区间计算",
				cache: "输入 token 中命中提供方前缀缓存的比例（缓存读取 ÷ 输入）。越高说明远端复用了越多已算好的前缀，悬停可见原始 token 数",
				toFirstToken: "从请求发出到首个 token 的总等待。预热请求则是「被领用 → 首个 token」——也就是这条预发请求最终实际花了多久",
				request: "压缩前 → 实际发送。未压缩时只显示一个数字",
				response: "响应在线路上实际收到的字节数（含网关压缩后的结果），以及响应的 content-encoding",
				total: "发出请求 → 流结束；悬停整行可看准备耗时与输入/输出 token 数"
			},
			running: "进行中",
			error: "失败"
		};

		/**
		 * Each column's share of the panel width, in table order: 时间, 提供方/模型,
		 * 发送, 服务端, 首 token, 到首token, 生成, tok/s, 缓存, 请求体, 响应体, 总计.
		 * takes the largest share; the numeric columns stay close to what their
		 * values need, and every cell truncates rather than overflowing.
		 */
		const COLUMN_SHARES = ["6%", "22%", "6%", "6%", "6%", "7%", "6%", "5%", "6%", "11%", "9%", "10%"];

		/**
		 * The conversation column's width handles are shell chrome, rendered for
		 * whichever view is active on a session. A view cannot un-render them, but
		 * they carry a stable `data-width-handle` attribute, so this stylesheet —
		 * installed only while this view is mounted — takes them out of the layout
		 * entirely. Selecting the attribute rather than the hashed class keeps it
		 * working across DSH builds.
		 */
		const HANDLE_STYLE = "[data-width-handle]{display:none !important}";

		/** The shell's own reserve for the composer, used until it publishes one. */
		const COMPOSER_FALLBACK_PX = 152;

		/** Breathing room between the panel's bottom edge and the viewport. */
		const PANEL_BOTTOM_MARGIN_PX = 16;

		const TS = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				padding: "12px 14px",
				color: "var(--dsw-alias-label-primary)",
				boxSizing: "border-box",
				position: "relative",
				width: "100%",
				maxWidth: "100%",
				minWidth: 0,
				height: "100%",
				minHeight: 0
			},
			head: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap", flex: "0 0 auto", minWidth: 0 },
			title: { margin: 0, fontSize: "15px", fontWeight: 600, lineHeight: 1.4 },
			intro: { margin: 0, fontSize: "12.5px", lineHeight: "19px", color: "var(--dsw-alias-label-tertiary)", minWidth: 0, overflowWrap: "anywhere", flex: "0 0 auto" },
			spacer: { marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "8px" },
			tile: { display: "inline-flex", alignItems: "baseline", gap: "5px" },
			tileLabel: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" },
			tileValue: { fontSize: "12.5px", fontVariantNumeric: "tabular-nums" },
			// The rows scroll here and the header stays pinned to the top of this box.
			// The panel's measured bound is what normally sizes it; this viewport
			// expression only covers the frame before that measurement lands, since
			// the shell lays the view area out with `min-height: auto` while a session
			// is active. `maxHeight` never forces the box open, so a shorter parent
			// still wins.
			tableWrap: {
				flex: "1 1 auto",
				minHeight: 0,
				overflow: "auto",
				maxHeight: "calc(100vh - 232px)"
			},
			// Fills the panel via the column shares below. An auto layout would size
			// each column to its own content, which both left the panel half empty and
			// handed the widest value (the size pair) the widest column. `separate`
			// with zero spacing is deliberate: a collapsed border does not paint on a
			// sticky header cell, so the header rule is drawn with a shadow instead.
			table: { borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: "12px", tableLayout: "fixed" },
			th: {
				textAlign: "right",
				padding: "4px 6px",
				cursor: "help",
				color: "var(--dsw-alias-label-tertiary)",
				fontWeight: 500,
				borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
				whiteSpace: "nowrap",
				position: "sticky",
				top: 0,
				zIndex: 2,
				background: "var(--dsw-alias-bg-base)",
				boxShadow: "inset 0 -0.5px 0 var(--dsw-alias-border-l2)"
			},
			thLeft: { textAlign: "left" },
			td: {
				textAlign: "right",
				padding: "4px 6px",
				borderBottom: "0.5px solid var(--dsw-alias-border-l1)",
				fontVariantNumeric: "tabular-nums",
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis"
			},
			tdLeft: { textAlign: "left" },
			mono: { fontFamily: "var(--ds-font-family-code)", fontSize: "11.5px" },
			dim: { color: "var(--dsw-alias-label-tertiary)" },
			errorText: { color: "var(--dsw-alias-state-error-primary)" },
			chip: {
				display: "inline-block",
				border: "0.5px solid var(--dsw-alias-border-l3)",
				borderRadius: "4px",
				padding: "0 4px",
				marginLeft: "6px",
				fontSize: "10px",
				color: "var(--dsw-alias-label-secondary)"
			},
			button: {
				border: "0.5px solid var(--dsw-alias-border-l3)",
				background: "transparent",
				color: "var(--dsw-alias-label-primary)",
				borderRadius: "14px",
				height: "26px",
				padding: "0 10px",
				font: "inherit",
				fontSize: "12px",
				cursor: "pointer"
			}
		};

		/** Format a millisecond phase; an absent phase renders as a dash, never a zero. */
		function formatMs(value) {
			if (value === null || value === undefined) return "–";
			if (value < 1000) return `${Math.round(value)}ms`;
			return `${(value / 1000).toFixed(2)}s`;
		}

		/** Format a byte count for a column that must stay narrow. */
		function formatBytes(value) {
			if (value === null || value === undefined) return "–";
			if (value < 1024) return `${value}B`;
			if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
			return `${(value / (1024 * 1024)).toFixed(2)}MB`;
		}

		/** `before → after` when the body was rewritten, otherwise the single sent size. */
		function formatRequest(item) {
			if (item.sentBytes === null || item.sentBytes === undefined) return "–";
			if (item.compressed && item.requestBytes !== null) return `${formatBytes(item.requestBytes)}→${formatBytes(item.sentBytes)}`;
			return formatBytes(item.sentBytes);
		}

		/** Format a wall-clock time as HH:MM:SS for the row label. */
		function formatClock(timestamp) {
			if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "–";
			const date = new Date(timestamp);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}

		/** The detail a compact row cannot show inline. */
		function rowDetail(item) {
			const parts = [];
			if (item.prepareMs !== null) parts.push(`准备 ${formatMs(item.prepareMs)}`);
			if (item.outputTokens !== null) parts.push(`输出 ${item.outputTokens} tokens`);
			if (item.cacheReadTokens !== null) parts.push(`缓存读取 ${item.cacheReadTokens} tokens`);
			if (item.prewarm !== null && item.prewarm !== undefined) {
				parts.push(`预传输：历史 ${item.prewarm.prefixBytes} 字节已于 ${item.prewarm.holdMs}ms 前发出，本次只补 ${item.prewarm.deltaBytes} 字节`);
				if (item.toFirstTokenMs !== null) parts.push(`被领用 → 首个 token ${formatMs(item.toFirstTokenMs)}`);
				if (item.totalMs !== null) parts.push(`被领用 → 结束 ${formatMs(item.totalMs)}`);
			}
			if (item.inputTokens !== null) parts.push(`输入 ${item.inputTokens} tokens`);
			if (item.responseBytes > 0) {
				const encoding = item.responseEncoding === null ? "未压缩" : item.responseEncoding;
				parts.push(`响应 ${formatBytes(item.responseBytes)}（${encoding}）`);
			}
			return parts.join(" · ");
		}

		/** The request-timing view rendered beside the shipped Trajectory. */
		function TimingView(props) {
			const h = React.createElement;
			const load = props.loadTimings;
			const sessionId = props.sessionId;
			const rootRef = React.useRef(null);
			const [maxHeight, setMaxHeight] = React.useState(null);
			const [state, setState] = React.useState({ status: "loading", error: null, measurements: [] });

			// Bound the panel to the space actually left below it, so it fits one
			// screen instead of overflowing into the shell's scroller — the symptom
			// was two nested scrollbars. The reference frame is the panel's own top,
			// which exists even on the first mount, unlike the table. The shell's
			// composer reserve is subtracted too, so the floating composer stops
			// sitting over the last rows.
			React.useEffect(() => {
				if (typeof window === "undefined") return () => {};
				const measure = () => {
					const node = rootRef.current;
					if (node === null || typeof node.getBoundingClientRect !== "function") return;
					const rect = node.getBoundingClientRect();
					// A container that is not laid out yet reports an all-zero rect, which
					// would compute a nearly full-height panel. Keep the stylesheet
					// fallback until a real measurement is available.
					if (rect.top <= 0) return;
					let composer = COMPOSER_FALLBACK_PX;
					if (typeof getComputedStyle === "function") {
						const declared = Number.parseFloat(getComputedStyle(node).getPropertyValue("--dsh-composer-height"));
						if (Number.isFinite(declared) && declared > 0) composer = declared;
					}
					const available = window.innerHeight - rect.top - composer - PANEL_BOTTOM_MARGIN_PX;
					setMaxHeight(Math.max(200, available));
				};
				measure();
				window.addEventListener("resize", measure);
				return () => window.removeEventListener("resize", measure);
			}, []);

			// Switching here from the transcript arrives scrolled to wherever the
			// transcript was, which for a live session is the bottom. The panel owns
			// no scroller of its own, so it asks the shell's scroller to bring its
			// top into view once it is laid out.
			React.useEffect(() => {
				const node = rootRef.current;
				if (node === null || typeof node.scrollIntoView !== "function") return () => {};
				const reveal = () => node.scrollIntoView({ block: "start", inline: "nearest" });
				if (typeof requestAnimationFrame === "function") requestAnimationFrame(reveal);
				else reveal();
				return () => {};
			}, []);

			// Hide the transcript's column-width handles for as long as this view is
			// mounted, so a drag over the table cannot resize the column.
			React.useEffect(() => {
				if (typeof document === "undefined") return () => {};
				const style = document.createElement("style");
				style.textContent = HANDLE_STYLE;
				document.head.appendChild(style);
				return () => style.remove();
			}, []);

			const reload = React.useCallback(() => {
				let cancelled = false;
				load(sessionId).then(
					(measurements) => {
						if (!cancelled) setState({ status: "ready", error: null, measurements });
					},
					(error) => {
						if (!cancelled) setState((previous) => ({ ...previous, status: "error", error: messageOf(error) }));
					}
				);
				return () => {
					cancelled = true;
				};
			}, [load, sessionId]);

			// Poll while the view is mounted: a running request appears as soon as
			// its stream is opened, and its phases fill in as it completes.
			React.useEffect(() => {
				const stop = reload();
				const timer = setInterval(reload, 2000);
				return () => {
					stop();
					clearInterval(timer);
				};
			}, [reload]);

			const columns = TIMING_COPY.column;
			const headerCells = [
				h("th", { key: "time", style: { ...TS.th, ...TS.thLeft }, title: TIMING_COPY.hint.time }, columns.time),
				h("th", { key: "route", style: { ...TS.th, ...TS.thLeft }, title: TIMING_COPY.hint.route }, columns.route),
				h("th", { key: "send", style: TS.th, title: TIMING_COPY.hint.send }, columns.send),
				h("th", { key: "server", style: TS.th, title: TIMING_COPY.hint.server }, columns.server),
				h("th", { key: "ttft", style: TS.th, title: TIMING_COPY.hint.ttft }, columns.ttft),
				h("th", { key: "toFirstToken", style: TS.th, title: TIMING_COPY.hint.toFirstToken }, columns.toFirstToken),
				h("th", { key: "generation", style: TS.th, title: TIMING_COPY.hint.generation }, columns.generation),
				h("th", { key: "throughput", style: TS.th, title: TIMING_COPY.hint.generation }, columns.throughput),
				h("th", { key: "cache", style: TS.th, title: TIMING_COPY.hint.cache }, columns.cache),
				h("th", { key: "request", style: TS.th, title: TIMING_COPY.hint.request }, columns.request),
				h("th", { key: "response", style: TS.th, title: TIMING_COPY.hint.response }, columns.response),
				h("th", { key: "total", style: TS.th, title: TIMING_COPY.hint.total }, columns.total)
			];

			const rows = [];
			const measurements = state.measurements;
			for (let index = measurements.length - 1; index >= 0; index--) {
				const item = measurements[index];
				const detail = rowDetail(item);
				rows.push(h("tr", { key: String(item.id), title: detail === "" ? undefined : detail },
					h("td", { key: "t", style: { ...TS.td, ...TS.tdLeft, ...TS.mono, ...TS.dim } }, formatClock(item.startedAt)),
					h("td", { key: "r", style: { ...TS.td, ...TS.tdLeft } },
						h("span", null, item.provider ?? "–"),
						item.model === null ? null : h("span", { style: { ...TS.mono, ...TS.dim } }, ` ${item.model}`),
						item.purpose === null ? null : h("span", { style: TS.chip }, item.purpose),
						item.compressed ? h("span", { style: TS.chip, title: TIMING_COPY.hint.request }, "gzip") : null,
						item.prewarm === null || item.prewarm === undefined
							? null
							: h("span", { style: TS.chip, title: `共享历史 ${item.prewarm.prefixBytes} 字节已在工具执行期间发出，本次只补了 ${item.prewarm.deltaBytes} 字节，持有 ${item.prewarm.holdMs}ms` }, "预热"),
						item.status === "running" ? h("span", { style: TS.chip }, TIMING_COPY.running) : null,
						item.status === "error" ? h("span", { style: { ...TS.chip, ...TS.errorText } }, TIMING_COPY.error) : null
					),
					h("td", { key: "s", style: TS.td }, formatMs(item.sendMs)),
					h("td", { key: "v", style: { ...TS.td, ...TS.dim } }, formatMs(item.serverMs)),
					h("td", { key: "f", style: TS.td }, formatMs(item.ttftMs)),
					h("td", { key: "w", style: TS.td, title: TIMING_COPY.hint.toFirstToken }, formatMs(item.toFirstTokenMs)),
					h("td", { key: "g", style: TS.td }, formatMs(item.generationMs)),
					h("td", { key: "k", style: TS.td }, item.tokensPerSecond === null ? "–" : item.tokensPerSecond.toFixed(1)),
					h("td", {
						key: "c",
						style: { ...TS.td, ...(item.cacheHitPercent === null ? TS.dim : {}) },
						title: item.cacheReadTokens === null
							? "提供方未返回缓存用量"
							: `缓存读取 ${item.cacheReadTokens} / 输入 ${item.inputTokens ?? "?"} token`
					}, item.cacheHitPercent === null ? "–" : `${item.cacheHitPercent.toFixed(1)}%`),
					h("td", { key: "q", style: TS.td, title: TIMING_COPY.hint.request }, formatRequest(item)),
					h("td", {
						key: "p",
						style: TS.td,
						title: item.responseEncoding === null
							? `${TIMING_COPY.hint.response}（本次未声明 content-encoding）`
							: `${TIMING_COPY.hint.response}（content-encoding: ${item.responseEncoding}）`
					},
						formatBytes(item.responseBytes),
						item.responseEncoding === null ? null : h("span", { style: TS.chip }, item.responseEncoding)
					),
					h("td", { key: "z", style: TS.td }, formatMs(item.totalMs))
				));
			}

			const latest = measurements.length === 0 ? null : measurements[measurements.length - 1];
			const children = [
				h("div", { key: "head", style: TS.head },
					h("h3", { style: TS.title }, TIMING_COPY.label),
					h("span", { style: TS.tile },
						h("span", { style: TS.tileLabel }, TIMING_COPY.requests),
						h("span", { style: TS.tileValue }, String(measurements.length))
					),
					latest === null ? null : h("span", { style: TS.tile },
						h("span", { style: TS.tileLabel }, TIMING_COPY.latest),
						h("span", { style: TS.tileValue },
							`${formatMs(latest.sendMs)} · ${formatMs(latest.ttftMs)} · ${formatMs(latest.generationMs)} · ${latest.tokensPerSecond === null ? "–" : latest.tokensPerSecond.toFixed(1)} tok/s`)
					),
					h("span", { style: TS.spacer }, h("button", { type: "button", style: TS.button, onClick: reload }, TIMING_COPY.refresh))
				),
				h("p", { key: "intro", style: TS.intro }, TIMING_COPY.intro)
			];
			if (state.error !== null) children.push(h("p", { key: "error", style: { ...TS.intro, ...TS.errorText } }, state.error));
			children.push(measurements.length === 0
				? h("p", { key: "empty", style: TS.intro }, state.status === "loading" ? TIMING_COPY.loading : TIMING_COPY.empty)
				: h("div", { key: "table", style: TS.tableWrap },
					h("table", { style: TS.table },
						h("colgroup", null, COLUMN_SHARES.map((width, index) => h("col", { key: `c${String(index)}`, style: { width } }))),
						h("thead", null, h("tr", null, headerCells)),
						h("tbody", null, rows)
					)
				));
			return h("div", { ref: rootRef, style: maxHeight === null ? TS.root : { ...TS.root, maxHeight } }, children);
		}

		//#endregion

		/**
		 * Mount the collapsed-by-default settings card, and — only while the
		 * Request timing preference is on — the per-request timing view beside the
		 * shipped Trajectory view.
		 * @param ctx - browser plugin context.
		 */
		function apply(ctx) {
			const ctl = createController(ctx);
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: NS,
				inject: () => ({ ctl })
			}, SettingsCard));

			// The scope derives from the shared settings mirror, so it is already
			// loading by the time this plugin activates and it republishes on every
			// document change — no wire read and no polling of our own.
			const scope = ctx.settingsScope.bind({ namespace: NS });

			ctx.slots.inject("conversation.view", () => {
				let registered;
				const sync = () => {
					const snapshot = scope.getSnapshot();
					// Stay undecided until the first section arrives, so a plugin the
					// user switched off never flashes a tab on page load.
					if (snapshot.status === "loading") return;
					const enabled = snapshot.status === "unavailable" || snapshot.value === undefined || snapshot.value === null
						? true
						: snapshot.value.timing !== false;
					if (enabled && registered === undefined) {
						registered = ctx.slots.register({
							name: "conversation.view",
							id: "request-timing",
							order: 11,
							label: () => TIMING_COPY.label,
							inject: () => ({ loadTimings: ctl.loadTimings })
						}, TimingView);
					} else if (!enabled && registered !== undefined) {
						registered();
						registered = undefined;
					}
				};
				sync();
				const unsubscribe = scope.subscribe(sync);
				return () => {
					unsubscribe();
					if (registered !== undefined) registered();
				};
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
