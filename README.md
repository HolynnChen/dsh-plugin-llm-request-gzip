# dsh-plugin-model-request-accelerator

**模型请求加速 / model request accelerator** — compress model request bodies, pre-transmit the shared history, and break down where each request spends its time.

Two things for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) model calls:

- **Gzip request-body compression**, per provider, configured in Settings → Plugins.
- **Request timing breakdown** — a view beside the Trajectory that splits every model call into its phases, with tokens-per-second.

> 中文文档：[README.zh.md](./README.zh.md)

## Gzip: what it actually does

This trips people up, so read it first:

| Direction | Default today | This plugin |
| --- | --- | --- |
| Response (downstream) | Node's undici `fetch` **already sends** `accept-encoding: gzip, deflate` and decompresses the reply automatically | Does nothing — there is nothing to enable |
| Request (upstream) | Not compressed; a JSON body carrying a long context and base64 images is uploaded as-is | **Compresses it** and adds `content-encoding: gzip` |

Measured: a 3043-byte chat-completions body becomes 79 bytes.

Both shipped adapters (`dsh-llm-deepseek`, `dsh-llm-pi-ai`) call the global `fetch` directly and the adapter seam exposes no header hook, so this plugin owns that seam for the lifetime of its fiber and restores the original `fetch` when the plugin is stopped or removed.

## Request timing

A view of its own appears next to **Trajectory** in the conversation view switcher, for as long as the preference above is on. It lists every model request of the current session, newest first, and splits each one:

```
stream begins ──▶ fetch() ──────▶ body sent ──────▶ first token ──────▶ end
      │             │                │                  │              │
      │          prepare          send            TTFT    │        generation
      │                            └──── server ─────┘   │              │
      └────────────────────────── total ───────────────────────────────┘
```

| Column | Meaning |
| --- | --- |
| 时间 / time | When the request was issued, to the second. |
| 提供方 / 模型 | Provider route, model, purpose (compaction or session title), a `gzip` chip when the body was really compressed, and a running or failed badge. |
| 发送 / send | The request being issued → **the body fully sent**. |
| 服务端 / server | Body sent → response headers received. |
| 首token | Wait until the first token: from the request being issued, or — for a pre-transmitted row — from the member being claimed. The server's own think time (from the body being sent) is in the row tooltip. |
| 生成 / generation | First token → stream end. |
| tok/s | Output tokens ÷ the generation window. |
| 缓存 / cache | Share of the prompt the provider served from its prefix cache. `inputTokens` counts *uncached* input only, so the prompt is cached + uncached and the rate is cached ÷ (cached + uncached); the raw counts are on hover. |
| 请求体 / request body | `before → after` when the body was gzipped, otherwise the single serialized size. |
| 响应体 / response body | Bytes actually received **on the wire**, plus the response's `content-encoding` when it declares one — so a gzip-encoded reply is labelled rather than merely looking small. A `–` means no chunk was attributed at all, which is a wiring fault to see rather than an empty reply. |
| 总计 / total | Fetch call → stream end. |

Every column header explains itself on hover, and hovering a row shows what does not fit: the preparation time (stream start → request issued), the input/output token counts, and the response size with its encoding.

The table fills the panel by fixed column shares — the provider/model text takes the largest one and the numeric columns take what their values need — so it neither leaves the panel half empty nor stretches whichever value happens to be longest.

The conversation column's own width handles are shell chrome, rendered for whichever view is active, so a view cannot un-render them — but they carry a stable `data-width-handle` attribute. While this view is mounted it installs one stylesheet rule, `[data-width-handle]{display:none}`, and removes it again on unmount: the transcript cannot be resized by a stray drag over the table, and every other view keeps the handle. The panel also asks the shell's scroller to reveal its top on open, because arriving from a live transcript would otherwise drop it at the bottom. The rows scroll inside the panel with the header pinned to the top of that box. The panel measures the space actually left below it — its own top, the shell's published `--dsh-composer-height`, and a small margin — and bounds itself to that, so it fits one screen and the shell's own scroller never appears alongside it. It has to measure rather than rely on `height: 100%`, because the shell gives the view area an `auto` height while a session is active. Both behaviours live in the two mount effects at the top of `TimingView` in `lib/client.js`; remove them and the panel behaves like every other view again.

### Prefix reuse

Prefill dominates a long-conversation request, and the shared prefix is the part worth not recomputing. That reuse is a **server-side** mechanism — providers hash the prompt prefix and reuse the computed KV cache — so the client's only lever is keeping the prefix byte-stable across turns, which DSH already does. The cache column is how you see whether it is working: it reports the provider's own accounting, so a high share means the prefill was largely skipped.

It is worth knowing why the obvious client-side idea — opening a request with the known prefix and appending the rest once tools finish — cannot help. An OpenAI-compatible `/chat/completions` body is one JSON document: the endpoint buffers it and starts inference only once the body is complete, so a prefix alone starts no work, and a dispatched request cannot be appended to. The speculative request would either be abandoned (having done nothing) or held open until it times out. Let the server do it, and keep the prefix stable.

### Why this differs from the Trajectory's TTFT

The Trajectory's own timing panel measures TTFT from the **start of the step** (`firstTokenTime - stepStartTime`), which folds body serialization and request sending into the wait. The Trajectory is a shipped bundle with no extension point for that panel, so this breakdown is delivered as its own view instead — and its "发送" boundary is the part the Trajectory cannot show.

### How it measures, and why nothing is guessed

`send` comes from undici's own `undici:request:bodySent` diagnostic — the moment the transport finished writing the body — and `server` from `undici:request:headers`. Response bytes come from `undici:request:bodyChunkReceived`, which reports **wire** bytes. All three are consumed through `node:diagnostics_channel`, so **the request is never modified to measure it**: the body keeps its `content-length` and no chunked encoding is introduced.

Those channels are process-wide, and the ones on the response side are also **socket-scoped**: on a pooled keep-alive connection they run inside the async context of whichever request first opened that socket. Reading the ambient context there attributes `headers` to an older, already-finished request — which is exactly why a naive implementation reports the server phase for the first request on a connection and `null` for every one after it. This plugin pairs each measurement with the undici request object at `undici:request:create` (which still runs in the caller's context) and looks every later diagnostic up by that identity, so pooled requests keep their phases. `test/host.test.mjs` asserts this on four sequential requests over one connection and fails if the pairing is reverted.

Measurements are held in memory on the Host (last 100 per session, last 40 sessions) and served to the page over the product's own authenticated `/api` route. They are not persisted, so they do not survive a DSH restart.

## Requirements

- DSH with the `web` profile (this plugin ships a browser half for the settings card).
- Node.js >= 20 (bundled with DSH).

## Install

### One command

```bash
curl -fsSL https://raw.githubusercontent.com/HolynnChen/dsh-plugin-model-request-accelerator/main/install.sh | sh
```

It clones the plugin into `$DSH_HOME/profiles/web/plugins/model-request-accelerator` and appends its loader entry to
`cordis.patch.yml`, leaving an already-registered entry alone — safe to re-run. Target another profile with
`DSH_HOME=... DSH_PROFILE=... sh`.

Then **reload the browser tab** and open **Settings → Plugins → Configuration**.

### Manual install

`DSH_HOME` defaults to `~/.dsh`; the steps below assume the `web` profile.

#### 1. Put the package inside your profile

```bash
git clone https://github.com/HolynnChen/dsh-plugin-model-request-accelerator.git \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web/plugins/model-request-accelerator"
```

No install step is needed for dependency resolution: Node walks up from the plugin directory into the profile's own hoisted `node_modules`, where `@deepseek-ai/schemastery` already lives. If that does not hold for your layout, run `npm install --omit=dev` inside the cloned directory.

#### 2. Register it in the profile's patch layer

`${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml` is a top-level YAML **array** of patch entries. Append:

```yaml
- insert:
    - id: model-request-accelerator
      name: './plugins/model-request-accelerator/lib/index.js'
```

The `name` resolves relative to the profile directory, so a relative path keeps working across machines. An absolute path works too.

> Prefer pnpm-managed installs? `dsh plugin --profile web add github:HolynnChen/dsh-plugin-model-request-accelerator` (requires `pnpm` on `PATH`) installs it into the profile, after which the same entry can use `name: 'dsh-plugin-model-request-accelerator'`.

#### 3. Reload the page

The `web` profile sets `patchReload: live`, so DSH watches `cordis.patch.yml` and re-composes the tree without a restart. **Reload the browser tab** — the client module graph is injected at page load, so an already-open page will not have the card.

Then open **Settings → Plugins → Configuration** and look for **Model request gzip**.

> **Updating an installed copy.** `patchReload: live` watches `cordis.patch.yml`, *not* plugin sources, so an edited Host half is only picked up by restarting `dsh web`. The browser bundle is different: it is re-read from disk, so a page reload is enough for the client half. Do both when in doubt.

## Configure

The card lives in **Settings → Plugins → Configuration**, collapsed like every other plugin card on that page. Expand it to see:

**The plugin switch**

- **Show the Request timing view** — default on. Turning it off also stops the Host recording timings, so a deployment that does not want the view pays nothing for it. The view tab appears and disappears immediately; no page reload is needed.

**One row per provider route**

- **Toggle** — compress this provider's model requests.
- **Minimum body size (bytes)** — default `1024`. Smaller requests are sent as-is, and compression is skipped whenever it would not actually make the body smaller.
- **Algorithm** — **brotli at quality 9** by default, measured at roughly 5–15% smaller than gzip for a comparable amount of time. Brotli's own default is quality 11, which is deliberately not used: it costs about a second of *synchronous* CPU per megabyte, blocking the event loop, for only a few percent more. A request body has no negotiation, so if an endpoint answers a shape rejection (411/415/501) to a brotli body the request is retried as gzip — the adapter never sees a failure it would not have seen uncompressed — and that endpoint is remembered, so brotli is attempted there exactly once. Choose `gzip` to never attempt it.

Each route's endpoint is shown next to it. Routes that share one endpoint are grouped, because that endpoint's traffic is compressed as soon as any one of them is enabled.

Settings persist under the `model-request-accelerator` key of `settings.yaml`:

```yaml
model-request-accelerator:
  providers:
    sg:
      enabled: true
      minBytes: 1024
      prewarm: true
  encoding: auto
  prewarmHoldMs: 120000
  prewarmPoolSize: 3
  timing: true
```

`encoding` is `auto` (prefer **brotli**) or `gzip`, settable section-wide or per provider.

### Pre-transmission (opt-in, per provider)

A multi-turn request re-sends its entire history every step. With **预传输 / pre-transmission** enabled for a provider, the plugin keeps a **pool of held requests** per conversation and puts the shared history on the wire before the request that needs it even exists — because a long history does not reach the far end instantly, and the longer it is, the longer a relay chain takes to carry it.

Each conversation's pool holds `prewarmPoolSize` members (default `3`). Members are opened at staggered moments and **advanced as content becomes known**, so the one that gets consumed has already been in flight for several steps rather than for one:

- **Open** — a model call goes out, so its own history is known; every member is advanced to it, and the pool is refilled. The bytes are slices of the request that was just captured — never reconstructed.
- **Fill** — the step ends asking for tools, so the assistant turn is added to every member while the tools run. Those bytes *are* a prediction of the adapter's serialization, so it is guarded: the captured body must round-trip through `JSON.parse`/`JSON.stringify` unchanged, and the previous assistant turn must use only fields this can reason about, and have the same shape (with or without tool calls). If the prediction is wrong it is caught byte for byte when the next request claims a member — and the fill then switches off for that provider, leaving the pool advancing on captured bytes alone. Adapters differ in how they frame that turn — pi-ai re-serializes tool-call arguments from the parsed object and omits `content` on a turn that produced no text — so the framings are **enumerated, and only the bytes they agree on are sent**. The pre-sent part stops where they diverge (usually at `content`, or at the arguments), and the rest is written verbatim when the request arrives. That makes the fill free of guesses: it can never pre-empt an adapter into a body the adapter would not have built, so a member is never discarded over one. The cost is coverage — the payload is exactly what the framings disagree about, so it is the skeleton that goes out early.
- **Consume** — the next request claims the **oldest** member whose bytes it continues and whose headers still match; the survivors are advanced and the pool refilled.
- **Destroy** — a step that ends the turn (`stop`, `max-tokens`, an error, an interruption) rather than `tool-calls` releases the whole pool **unless the agent already has input waiting** (`agent.inbox.hasPending`: a queued next turn, or input due at the next step boundary). A turn the user has already queued past repeats the same history, so the pool is kept and used directly. The same applies after a mismatch: the pool is abandoned *and immediately re-opened from the prefix that was just captured*, so the following step is pre-transmitted again. Every member also expires after `prewarmHoldMs` of **idleness** — the timer restarts on each advance, so a member that keeps moving with the conversation is not retired by age.

The pool belongs to one **agent**, not to a session tree. A subagent is a separate agent with its own session id, and the loop stamps each request with its own agent's session, so a child's pool never mixes with its parent's — even when the two histories are byte-identical, which is the case a shared pool would silently corrupt. The parent's own inbox is likewise read per agent, so a queued turn on the parent does not keep a child's pool alive, or the reverse.

The one thing shared across agents is the decision to stop pre-transmitting to an **endpoint**, because whether it accepts a chunked body is a property of the endpoint rather than of the conversation asking. It takes a shape rejection (411/415/501), which retrying cannot fix, or three consecutive failures — so one transient 5xx or rate limit does not switch the feature off everywhere.

A held member carries a chunked body, because its length cannot be known before the increment is. If an endpoint answers badly — or refuses a chunked body — pre-transmission switches off for that endpoint, and a shape rejection (411/415/501) is resent as an ordinary request.

The ledger is **durable per session**: rows are stored one document per session in the deployment's storage backend (`~/.dsh/storages`, via the storage domain layer), so reopening a session — or restarting the harness — shows its history rather than an empty panel. A profile without a storage backend keeps the ledger in memory, exactly as before.

Rows that used it carry a **预热** chip; hover it for the pre-sent bytes, the increment, and how long the member was held. That last number is the lead time actually won, and it is the honest way to tell whether a longer pool is worth anything on a given link.

gzip and pre-transmission compose: the split keeps **one** deflate stream open across every part, so the parts decompress as a single body and the compression is kept rather than traded away.

### Safety notes

- Every provider is **off by default**.
- Confirm your gateway accepts `content-encoding: gzip` on a provider you can afford to break before enabling it for the provider serving your current session. If the gateway does not support it, that provider's requests will fail.
- If the rewrite itself throws, the plugin falls back to sending the request uncompressed: a bug in this plugin cannot break model requests.

### Confirming it works

The Host logs one line per compressed request:

```
model-request-accelerator: sg request compressed 3043 -> 79 bytes
```

`endpoint-matched` appears instead of a provider name when a request could not be attributed to a provider (see below).

## How provider attribution works

A request URL is all the `fetch` layer sees. When several provider routes share one endpoint — as they do when e.g. `llm-deepseek` and `llm-pi-ai.providers.sg` both point at the same gateway — the URL alone cannot tell them apart, and a per-provider switch would silently behave per-endpoint.

So the plugin hooks the `llm/stream` waterfall and binds the streaming call's provider into an `AsyncLocalStorage` scope. Each iterator resumption runs inside that scope, so the identity survives the adapter's internal `await`s (image serialization, file uploads) and concurrent streams cannot clobber each other. Endpoint matching is only a fallback for requests with no attributed provider, where the longest matching endpoint wins and the policies of the routes on it are OR-ed.

### Why not a dynamic Cordis plugin?

Dynamic plugins run in a `node:vm` sandbox where `fetch` and `require` are trapped to throw, `process` is `undefined`, and there is no zlib, `Buffer`, or `CompressionStream`. Such a plugin can neither compress a body nor reach the realm the adapters fetch from, so this has to be a file-loaded Cordis plugin.

## Uninstall

Delete the `model-request-accelerator` entry from `cordis.patch.yml` (and the cloned directory). The change is live; reload the page and the card is gone.

## Tests

```bash
npm test
```

- `test/host.test.mjs` runs the real `apply()` against a fake Cordis context and a spied `globalThis.fetch`, covering schema resolution, the settings hook contract, `llm/stream` attribution, and the fetch rewrite. Its fixture deliberately reproduces the awkward case — two routes sharing one endpoint — to prove the switch is genuinely per-provider. It also measures a **real** request end to end: a local SSE endpoint whose think time, first-token delay and decode window are separated on purpose, driven through the plugin's real transport diagnostics.
- `test/client.test.mjs` executes the real browser bundle under a stubbed module loader and a hook-tracking React stand-in, so it can render the card, click it and re-render: that the bundle id matches the package name, that the card registers on the settings namespace and starts **collapsed**, that the timing switch writes a top-level field, and that the timing view is registered only while the preference is on — including that it stays undecided until the first section arrives and is added or removed as the preference changes.
- `test/timing.test.mjs` drives the phase arithmetic with injected clocks, so every boundary is asserted at an exact millisecond, including the cases where a phase is genuinely absent.

## Layout

| File | Role |
| --- | --- |
| `install.sh` | One-command installer: clones the package into the profile and registers it in `cordis.patch.yml`. |
| `lib/compress.js` | Gzip decision core: policy compilation, endpoint index, attribution resolution, gzip plan, header rewriting. No Cordis, globals, or zlib, so it is directly unit-testable. |
| `lib/timing.js` | Timing state machine: phase boundaries, throughput, per-session ring buffer, detached wire projection. Pure over injected clocks. |
| `lib/index.js` | Host half: settings section, `llm/stream` attribution, the timing measurement and its authenticated `/api` route, `globalThis.fetch` patch and restore. |
| `lib/client.js` | Browser half: the settings card and the request-timing view. Plain CJS factory contract, no JSX or ESM syntax. |

## License

[MIT](./LICENSE)
