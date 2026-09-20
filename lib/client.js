/**
 * Browser half: the 模型请求加速 card inside Settings > Plugins.
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
	id: "dsh-plugin-model-request-accelerator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** The Host settings namespace this card edits. */
		const NS = "model-request-accelerator";

		/** How long an automatic check is trusted before it is repeated. */
		const VERSION_CACHE_MS = 5 * 60 * 1000;

		/**
		 * The last automatic answer and when it arrived. The panel is opened far
		 * more often than a release is published, so a check that just ran is
		 * reused; the button always asks afresh.
		 */
		let cachedRelease = null;

		/** Authenticated route the Host serves for the version and the update action. */
		const VERSION_PATH = "/api/model-request-accelerator/version";

		/** Authenticated route reporting what real traffic taught us per endpoint. */
		const ENDPOINTS_PATH = "/api/model-request-accelerator/endpoints";

		/** Authenticated route reporting the timing ledger's size, and clearing it. */
		const LEDGER_PATH = "/api/model-request-accelerator/ledger";
		/** Mirrors the Host default; used before a section value exists. */
		const DEFAULT_MIN_BYTES = 1024;
		/** Mirrors the Host default for the pre-transmission pool. */
		const DEFAULT_POOL_SIZE = 3;

		/** Required services (cordis fiber inject). */
		const inject = ["slots", "remote", "remote.settings", "remote.llm", "settingsScope"];

		//#region copy + styles

		const COPY = {
			title: "模型请求加速",
			description: "压缩请求体、预传输共享历史，并分解每次请求的耗时。",
			intro:
				"响应侧压缩由 Node 默认开启；这里控制请求体：对指定提供方以 br（优先）或 gzip 上传，长上下文收益最大。",
			timing: "展示「请求耗时」面板",
			timingHint: "在会话视图切换器里与「轨迹」并列，关闭后不再记录耗时。",
			brotliRefused: "压缩已退回 gzip（该 endpoint 拒绝过 br）",
			prewarmBlocked: "预传输已停用（该 endpoint 拒绝过 chunked 请求体）",
			endpointFailures: (n) => `压缩连续失败 ${n} 次`,
			loading: "正在读取设置…",
			retry: "重试",
			empty: "当前没有已注册的提供方路由。",
			unavailable: "设置当前不可写（只读或命名空间未就绪）。",
			prewarm: "预传输",
			prewarmHint: "提前把这次请求的共享历史发到链路上，下一步真正发出时只补新增的那一小段（通常几百字节到几 KB），因此从「发起请求」到「首 token」之间几乎不用再等上传。适合链路上有中转站的场景；需要该 endpoint 接受 chunked 请求体，否则会被自动停用（面板会写明）。",
			pool: "预传输池大小",
			columnProvider: "提供方",
			columnCompress: "压缩",
			compressHint: "勾选 = 该提供方的请求体压缩后再上传（算法由上面的「压缩算法」决定，br 优先、不可用时退回 gzip）。长上下文在中转站上的处理开销与收到的字节数成正比，压掉一半字节通常直接换来首 token 变快；内容对模型完全一致。",
			encoding: "压缩算法",
			encodingAuto: "自动（优先 br）",
			encodingGzip: "仅 gzip",
			encodingHint: "br 在同样耗时下比 gzip 再小 5~15%；无法使用时自动退回 gzip。",
			ledger: "请求耗时记录",
			clear: "清空",
			confirmClear: "确认清空",
			cancel: "取消",
			ledgerHint: "记录保存在部署的存储后端里，清空后不可恢复；当前会话的耗时面板也会变空。",
			ledgerEmpty: "暂无记录",
			ledgerCleared: (n) => `已清空 ${n} 个会话的记录`,
			ledgerClearFailed: "清空失败",
			version: "版本",
			checkUpdate: "检查更新",
			updateTo: (v) => `更新到 ${v}`,
			versionHint: "更新会在本插件目录执行 git pull --ff-only；更新后需要重启 dsh web 才会生效。",
			checking: "检查中…",
			updating: "更新中…",
			upToDate: "已是最新版本",
			checkFailed: "无法获取远端版本",
			updated: (v) => `已更新到 ${v}，重启 dsh web 后生效`,
			updateFailed: "更新失败",
			poolHint: "每个会话同时保持几条预发请求。链路越长，越需要让它提前在途。",
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
			// Plugin-level settings: a labelled control, its explanation beneath.
			settings: { display: "flex", flexDirection: "column", gap: "11px" },
			setting: { display: "flex", flexDirection: "column", gap: "3px", minWidth: 0 },
			settingLine: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", minWidth: 0 },
			settingLabel: { fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" },
			cellCheck: { margin: 0, marginTop: "2px", flex: "none", justifySelf: "center" },
			// A heading for a centred switch column, with a pointer that says it has
			// something to read.
			colHeadCenter: { justifySelf: "center", cursor: "help" },
			// Providers: one grid with headings, so columns align across every row.
			gridProviders: {
				display: "grid",
				// Provider first, then the two switches. The name column takes whatever
				// space is left, which both fills the panel and holds the switches
				// against its right edge.
				gridTemplateColumns: "minmax(0, 1fr) 56px 72px",
				alignItems: "center",
				gap: "7px 12px"
			},
			colHead: {
				justifySelf: "start",
				fontSize: "11px",
				lineHeight: "16px",
				color: "var(--dsw-alias-label-tertiary)",
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis"
			},
			section: {
				borderTop: "0.5px solid var(--dsw-alias-border-l2)",
				paddingTop: "12px",
				display: "flex",
				flexDirection: "column",
				gap: "9px"
			},
			groupHead: { gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: "3px", minWidth: 0, paddingTop: "7px" },
			routeName: {
				fontSize: "13px",
				fontWeight: 500,
				lineHeight: "20px",
				color: "var(--dsw-alias-label-primary)",
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis"
			},
			identity: { display: "flex", alignItems: "baseline", gap: "6px", minWidth: 0, overflow: "hidden" },
			mono: { fontFamily: "var(--ds-font-family-code)", fontSize: "11.5px", color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap", flex: "none" },
			select: {
				height: "28px",
				borderRadius: "8px",
				border: "0.5px solid var(--dsw-alias-border-l4)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)",
				fontSize: "12px",
				padding: "0 6px"
			},
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
		 * Group routes by endpoint so a shared gateway renders as one block.
		 *
		 * The grouping is presentational. Each route's switches are its own — the
		 * plugin applies the policy of the provider that issued the request, and the
		 * endpoint only decides when a request cannot be attributed at all.
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
					encoding: own !== undefined && own.value !== null && typeof own.value === "object" && own.value.encoding === "gzip" ? "gzip" : "auto",
					routes
				};
			}

			/**
			 * Persist one edit — a provider's policy, or the plugin-level timing
			 * switch. Every field is path-addressed, so a concurrent edit elsewhere
			 * in the section is never overwritten.
			 * @param target - a provider route, or one of the literals `timing`,
			 *   `encoding` and `prewarmPoolSize`.
			 * @param patch - `{ enabled }`, `{ prewarm }`, `{ minBytes }` or
			 *   `{ value }`, depending on the target.
			 * @param revision - the revision the edit was read at.
			 */
			async function write(target, patch, revision) {
				const ops = [];
				if (target === "timing") {
					if (typeof patch.enabled === "boolean") ops.push({ op: "set", path: ["timing"], value: patch.enabled });
				} else if (target === "encoding") {
					if (patch.value === "auto" || patch.value === "gzip") ops.push({ op: "set", path: ["encoding"], value: patch.value });
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
				const answer = await fetch(`/api/model-request-accelerator/timings${query}`, { headers: { accept: "application/json" } });
				if (!answer.ok) throw new Error(`timing ledger unavailable (HTTP ${answer.status})`);
				const payload = await answer.json();
				return payload !== null && typeof payload === "object" && Array.isArray(payload.measurements) ? payload.measurements : [];
			}

			return { read, write, loadTimings };
		}

		//#endregion
		//#region card component

		/**
		 * One provider's three grid cells, in table order: the identity, the
		 * compression switch, the pre-transmission switch. Cells rather than a row,
		 * so every provider lines up under the same column headings however long its
		 * name is, and the whole set is placed by the grid's own column template.
		 */
		function routeCells(props) {
			const h = React.createElement;
			const route = props.route;
			const disabled = !props.writable || props.busy;
			return [
				h("span", { key: `${route.id}:name`, style: S.identity },
					h("span", { style: S.routeName }, route.name),
					h("span", { style: S.mono }, route.id)
				),
				h("input", {
					key: `${route.id}:gzip`,
					type: "checkbox",
					checked: route.enabled,
					disabled,
					title: `${route.id}：${COPY.compressHint}`,
					style: S.cellCheck,
					onChange: (event) => props.onToggle(route.id, event.target.checked)
				}),
				h("input", {
					key: `${route.id}:prewarm`,
					type: "checkbox",
					checked: route.prewarm,
					disabled,
					title: COPY.prewarmHint,
					style: S.cellCheck,
					onChange: (event) => props.onPrewarm(route.id, event.target.checked)
				})
			];
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
					setNotice(target === "timing" ? "请求耗时设置已保存" : target === "prewarmPoolSize" ? "预传输池大小已保存" : target === "encoding" ? "压缩算法已保存" : `${target} 已保存`);
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
			const onPrewarm = React.useCallback((route, prewarm) => {
				save(route, { prewarm });
			}, [save]);
			const onPool = React.useCallback((value) => {
				save("prewarmPoolSize", { value });
			}, [save]);
			const onEncoding = React.useCallback((event) => {
				save("encoding", { value: event.target.value });
			}, [save]);
			const [release, setRelease] = React.useState({ version: null, latest: null, updateAvailable: false });
			const [releaseState, setReleaseState] = React.useState("idle");
			const [releaseNote, setReleaseNote] = React.useState(null);
			const [endpointState, setEndpointState] = React.useState({});
			const [ledgerSize, setLedgerSize] = React.useState(null);
			const [ledgerAction, setLedgerAction] = React.useState("idle");
			const [ledgerNote, setLedgerNote] = React.useState(null);

			/** What the ledger holds, as one line: sessions, rows and bytes. */
			const ledgerText = (stats) => {
				if (stats === null) return "…";
				const sessions = stats.durableSessions + stats.memorySessions;
				const bytes = formatBytes(stats.bytes);
				if (sessions === 0 && stats.memoryRows === 0) return COPY.ledgerEmpty;
				return `${sessions} 个会话 · ${bytes}${stats.durable ? "" : "（未启用持久化）"}`;
			};

			const clearLedger = React.useCallback(() => {
				setLedgerAction("busy");
				fetch(`${LEDGER_PATH}?action=clear`, { method: "POST", headers: { accept: "application/json" } }).then((answer) => answer.json()).then((payload) => {
					setLedgerAction("idle");
					if (payload === null || typeof payload !== "object") {
						setLedgerNote(COPY.ledgerClearFailed);
						return;
					}
					setLedgerSize(payload);
					setLedgerNote(COPY.ledgerCleared(payload.durableSessions ?? 0));
				}).catch((error) => {
					setLedgerAction("idle");
					setLedgerNote(`${COPY.ledgerClearFailed}：${String(error?.message ?? error)}`);
				});
			}, []);
			React.useEffect(() => {
				let live = true;
				fetch(LEDGER_PATH, { headers: { accept: "application/json" } }).then((answer) => answer.json()).then((payload) => {
					if (live && payload !== null && typeof payload === "object") setLedgerSize(payload);
				}).catch(() => {});
				return () => {
					live = false;
				};
			}, []);
			React.useEffect(() => {
				let live = true;
				fetch(ENDPOINTS_PATH, { headers: { accept: "application/json" } }).then((answer) => answer.json()).then((payload) => {
					if (live && payload !== null && typeof payload === "object" && payload.endpoints !== null && typeof payload.endpoints === "object") setEndpointState(payload.endpoints);
				}).catch(() => {});
				return () => {
					live = false;
				};
			}, []);
			React.useEffect(() => {
				let live = true;
				// Opening the panel checks for an update by itself. The result is shown,
				// so it is something the user can see rather than a silent request whose
				// only effect is a button that happens to say 更新到 X.
				if (cachedRelease !== null && Date.now() - cachedRelease.at < VERSION_CACHE_MS) {
					setRelease(cachedRelease.value);
					if (cachedRelease.value.updateAvailable !== true) setReleaseNote(COPY.upToDate);
					return undefined;
				}
				setReleaseState("checking");
				fetch(VERSION_PATH, { headers: { accept: "application/json" } }).then((answer) => answer.json()).then((payload) => {
					if (!live || payload === null || typeof payload !== "object") return;
					cachedRelease = { at: Date.now(), value: payload };
					setRelease(payload);
					setReleaseState("idle");
					setReleaseNote(payload.updateAvailable === true || payload.latest === null ? null : COPY.upToDate);
				}).catch(() => {
					// A failed automatic check is not worth interrupting anyone over.
					if (live) setReleaseState("idle");
				});
				return () => {
					live = false;
				};
			}, []);
			const onUpdate = React.useCallback(() => {
				setReleaseState("updating");
				setReleaseNote(null);
				fetch(`${VERSION_PATH}?action=update`, { method: "POST", headers: { accept: "application/json" } }).then((answer) => answer.json()).then((payload) => {
					setReleaseState("idle");
					if (payload?.ok === true) {
						setRelease((current) => ({ ...current, version: payload.to, updateAvailable: false }));
						setReleaseNote(COPY.updated(payload.to ?? "?"));
					} else {
						setReleaseNote(`${COPY.updateFailed}：${String(payload?.output ?? "").split("\n").slice(-1)[0] || "?"}`);
					}
				}).catch((error) => {
					setReleaseState("idle");
					setReleaseNote(`${COPY.updateFailed}：${String(error?.message ?? error)}`);
				});
			}, []);
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
				// Plugin-level settings: a labelled control with its explanation
				// underneath, so nothing floats to the far edge.
				children.push(h("div", { key: "settings", style: S.settings },
					h("div", { key: "timing", style: S.setting },
						h("label", { style: S.settingLine },
							h("input", {
								type: "checkbox",
								checked: snapshot.timing,
								disabled: !snapshot.writable || busy === "timing",
								style: S.cellCheck,
								onChange: (event) => save("timing", { enabled: event.target.checked })
							}),
							h("span", { style: S.settingLabel }, COPY.timing)
						),
						h("span", { style: S.muted }, COPY.timingHint)
					),
					h("div", { key: "pool", style: S.setting },
						h("div", { style: S.settingLine },
							h("span", { style: S.settingLabel }, COPY.pool),
							h("input", {
								key: `pool:${String(snapshot.prewarmPoolSize)}`,
								type: "number",
								min: 1,
								step: 1,
								defaultValue: String(snapshot.prewarmPoolSize),
								disabled: !snapshot.writable || busy === "prewarmPoolSize",
								style: S.input,
								title: COPY.poolHint,
								onFocus: (event) => event.target.select(),
								onKeyDown: (event) => {
									if (event.key === "Enter") event.target.blur();
								},
								onBlur: poolBlur
							})
						),
						h("span", { style: S.muted }, COPY.poolHint)
					),
					h("div", { key: "encoding", style: S.setting },
						h("div", { style: S.settingLine },
							h("span", { style: S.settingLabel }, COPY.encoding),
							h("select", {
								key: `encoding:${snapshot.encoding}`,
								value: snapshot.encoding,
								disabled: !snapshot.writable || busy === "encoding",
								style: S.select,
								onChange: onEncoding
							},
								h("option", { key: "auto", value: "auto" }, COPY.encodingAuto),
								h("option", { key: "gzip", value: "gzip" }, COPY.encodingGzip)
							)
						),
						h("span", { style: S.muted }, COPY.encodingHint)
					),
					h("div", { key: "ledger", style: S.setting },
						h("div", { style: S.settingLine },
							h("span", { style: S.settingLabel }, COPY.ledger),
							h("span", { style: S.muted }, ledgerText(ledgerSize)),
							ledgerAction === "confirm"
								? h("button", { type: "button", style: S.button, onClick: clearLedger }, COPY.confirmClear)
								: h("button", { type: "button", style: S.button, disabled: ledgerAction === "busy", onClick: () => setLedgerAction("confirm") }, COPY.clear),
							ledgerAction === "confirm"
								? h("button", { type: "button", style: S.button, onClick: () => setLedgerAction("idle") }, COPY.cancel)
								: null
						),
						h("span", { style: S.muted }, ledgerNote === null ? COPY.ledgerHint : ledgerNote)
					),
					h("div", { key: "version", style: S.setting },
						h("div", { style: S.settingLine },
							h("span", { style: S.settingLabel }, `${COPY.version} ${release.version ?? "—"}`),
							release.updateAvailable
								? h("button", { type: "button", style: S.button, disabled: releaseState === "updating", onClick: onUpdate },
									releaseState === "updating" ? COPY.updating : COPY.updateTo(release.latest))
								: h("button", {
									type: "button",
									style: S.button,
									disabled: releaseState === "checking",
									onClick: () => {
										setReleaseState("checking");
										setReleaseNote(null);
										fetch(VERSION_PATH, { headers: { accept: "application/json" } }).then((answer) => answer.json()).then((payload) => {
											setReleaseState("idle");
											if (payload !== null && typeof payload === "object") {
												setRelease(payload);
												setReleaseNote(payload.updateAvailable ? null : payload.latest === null ? COPY.checkFailed : COPY.upToDate);
											}
										}).catch(() => {
											setReleaseState("idle");
											setReleaseNote(COPY.checkFailed);
										});
									}
								}, releaseState === "checking" ? COPY.checking : COPY.checkUpdate)
						),
						h("span", { style: S.muted }, releaseNote === null ? COPY.versionHint : releaseNote)
					)
				));
				// Providers: ONE grid holding the headings, the group labels and every
				// route. Separate grids would each size their `max-content` columns from
				// their own content, which pulls a heading off the column it labels.
				const groups = groupRoutes(snapshot.routes);
				const cells = [
					h("span", { key: "h-name", style: S.colHead }, COPY.columnProvider),
					h("span", { key: "h-gzip", style: { ...S.colHead, ...S.colHeadCenter }, title: COPY.compressHint }, COPY.columnCompress),
					h("span", { key: "h-prewarm", style: { ...S.colHead, ...S.colHeadCenter }, title: COPY.prewarmHint }, COPY.prewarm)
				];
				for (const group of groups) {
					if (group.endpoint !== null) {
						cells.push(h("div", { key: `${group.endpoint}:head`, style: S.groupHead },
						(() => {
							// What this endpoint taught us, from real requests — not a probe.
							const state = group.endpoint === null ? undefined : endpointState[group.endpoint];
							const notes = [];
							if (state?.brotliRefused === true) notes.push(COPY.brotliRefused);
							if (state?.prewarmBlocked === true) notes.push(COPY.prewarmBlocked);
							else if (state?.failures > 0) notes.push(COPY.endpointFailures(state.failures));
							return notes.length === 0 ? null : h("span", { style: S.muted }, notes.join(" · "));
						})(),
						));
					}
					for (const route of group.routes) {
						cells.push(...routeCells({
							route,
							busy: busy === route.id,
							writable: snapshot.writable,
							onToggle,
							onPrewarm
						}));
					}
				}
				children.push(h("div", { key: "providers", style: S.section },
					snapshot.routes.length === 0
						? h("p", { key: "empty", style: S.muted }, COPY.empty)
						: h("div", { key: "grid", style: S.gridProviders }, cells)
				));
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

		/** Why a request was not served from the pre-transmission pool. */
		const PREWARM_MISS = {
			empty: "池里没有可用的预发请求：可能已过期，或因历史变化被丢弃",
			mismatch: "没有任何成员的字节能被这次请求延续——历史在两次请求之间被改写了（例如上下文压缩，或过大的附件被卸载成文本）",
			shape: "这次请求的 body 形态不适合预传输",
			failed: "已领用的预发请求在交接时断了：挂起的连接可能在空闲期间被对端关闭，也可能被一次并发的池子推进中止。本次只能整段重传。",
			aborted: "请求在领用后被取消",
			unsupported: "该提供方的请求体里没有可共享的对话数组（例如 Responses 协议用的是 input 字符串），预传输对它不适用",
			rejected: "该 endpoint 以不支持请求体压缩的方式拒绝了它（411/415/501），已改用普通请求重发"
		};

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
				generation: "生成",
				throughput: "tok/s",
				cache: "缓存",
				toFirstToken: "首token",
				request: "请求体",
				response: "响应体",
				total: "总计"
			},
			hint: {
				time: "该请求发出的本地时刻",
				route: "提供方路由与模型；br 或 gzip 表示请求体确实被压缩过，预热表示这次请求复用了提前发出的历史",
				send: "发出请求 → 请求体全部发送完毕",
				server: "发送完毕 → 收到响应头",
				generation: "首个 token → 流结束；tok/s 按此区间计算",
				cache: "提示词中命中提供方前缀缓存的比例。输入 token 只统计未缓存的部分，所以提示词是「缓存读取 + 未缓存输入」，比例为 缓存读取 ÷（缓存读取 + 未缓存输入）；悬停可见原始 token 数",
				toFirstToken: "等到首个 token 花了多久。普通请求从发出算起；预热请求从被领用算起（它的历史早已在途）",
				request: "压缩前 → 实际发送。未压缩时只显示一个数字",
				response: "响应在线路上实际收到的字节数（含网关压缩后的结果），以及响应的 content-encoding",
				total: "发出请求 → 流结束；悬停整行可看准备耗时与输入/输出 token 数"
			},
			running: "进行中",
			error: "失败"
		};

		/**
		 * Each column's share of the panel width, in table order: 时间, 提供方/模型,
		 * 发送, 服务端, 首token, 生成, tok/s, 缓存, 请求体, 响应体, 总计. The provider
		 * text takes the largest share; the numeric columns stay close to what their
		 * values need, and every cell truncates rather than overflowing.
		 */
		const COLUMN_SHARES = ["6%", "25%", "6%", "6%", "8%", "6%", "5%", "6%", "11%", "9%", "12%"];

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
			if (item.ttftMs !== null) parts.push(`服务端首 token（发送完毕起算）${formatMs(item.ttftMs)}`);
			if (item.outputTokens !== null) parts.push(`输出 ${item.outputTokens} tokens`);
			if (item.cacheReadTokens !== null) parts.push(`缓存读取 ${item.cacheReadTokens} tokens`);
			if (item.prewarm !== null && item.prewarm !== undefined) {
				const wire = item.prewarm.deltaWireBytes === undefined || item.prewarm.deltaWireBytes === null
					? ""
					: `（压缩后 ${formatBytes(item.prewarm.deltaWireBytes)}）`;
				// The fixed fields were moved ahead of the conversation, so what is left
				// after it is normally just the closing brackets — the tool schemas
				// travel inside the prefix now.
				const tail = item.prewarm.tailBytes === undefined || item.prewarm.tailBytes === null || item.prewarm.tailBytes <= 0
					? ""
					: `；另有 ${formatBytes(item.prewarm.tailBytes)} 在对话数组之后（通常只剩收尾括号）`;
				parts.push(`预传输：共享历史 ${formatBytes(item.prewarm.prefixBytes)} 已于 ${item.prewarm.holdMs}ms 前发出，本次只补 ${formatBytes(item.prewarm.deltaBytes)}${wire}${tail}`);
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
						item.compressed ? h("span", { style: TS.chip, title: TIMING_COPY.hint.request }, item.encoding ?? "gzip") : null,
						item.prewarm === null || item.prewarm === undefined
							? null
							: h("span", { style: TS.chip, title: `共享历史 ${item.prewarm.prefixBytes} 字节已提前 ${item.prewarm.holdMs}ms 发出，本次只补了 ${item.prewarm.deltaBytes} 字节` }, "预热"),
						item.prewarmMiss === null || item.prewarmMiss === undefined
							? null
							: h("span", { style: { ...TS.chip, ...TS.dim }, title: `未预热：${PREWARM_MISS[item.prewarmMiss] ?? item.prewarmMiss}` }, "预热✗"),
						item.status === "running" ? h("span", { style: TS.chip }, TIMING_COPY.running) : null,
						item.status === "error" ? h("span", { style: { ...TS.chip, ...TS.errorText } }, TIMING_COPY.error) : null
					),
					h("td", { key: "s", style: TS.td }, formatMs(item.sendMs)),
					h("td", { key: "v", style: { ...TS.td, ...TS.dim } }, formatMs(item.serverMs)),
					h("td", { key: "w", style: TS.td, title: TIMING_COPY.hint.toFirstToken }, formatMs(item.toFirstTokenMs)),
					h("td", { key: "g", style: TS.td }, formatMs(item.generationMs)),
					h("td", { key: "k", style: TS.td }, item.tokensPerSecond === null ? "–" : item.tokensPerSecond.toFixed(1)),
					h("td", {
						key: "c",
						style: { ...TS.td, ...(item.cacheHitPercent === null ? TS.dim : {}) },
						title: item.cacheReadTokens === null
							? "提供方未返回缓存用量"
							: `缓存读取 ${item.cacheReadTokens} / 未缓存输入 ${item.inputTokens ?? "?"} token（提示词合计 ${item.cacheReadTokens + (item.inputTokens ?? 0)}）`
					}, item.cacheHitPercent === null ? "–" : `${item.cacheHitPercent.toFixed(1)}%`),
					h("td", { key: "q", style: TS.td, title: TIMING_COPY.hint.request }, formatRequest(item)),
					h("td", {
						key: "p",
						style: TS.td,
						title: item.responseBytes === null
							? "没有统计到任何响应字节——这条响应没有被归属到本行"
							: item.responseEncoding === null
								? `${TIMING_COPY.hint.response}（本次未声明 content-encoding）`
								: `${TIMING_COPY.hint.response}（content-encoding: ${item.responseEncoding}）`
					},
						item.responseBytes === null ? "–" : formatBytes(item.responseBytes),
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
