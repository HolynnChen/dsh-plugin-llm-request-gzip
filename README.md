# dsh-plugin-llm-request-gzip

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
| 首 token / TTFT | Body sent → **first token**. |
| 生成 / generation | First token → stream end. |
| tok/s | Output tokens ÷ the generation window. |
| 请求体 / request body | `before → after` when the body was gzipped, otherwise the single serialized size. |
| 响应体 / response body | Bytes actually received **on the wire** (so a gateway-compressed reply counts as what was transferred). |
| 总计 / total | Fetch call → stream end. |

Hovering a row shows what does not fit: the preparation time (stream start → request issued) and the input/output token counts.

The conversation column's own width handles are shell chrome, rendered for whichever view is active. This view covers exactly their two gutter bands so a stray drag over the table cannot resize the column; both bands lie outside the centred content column, so no data sits under them. That behaviour lives in `SHIELD_WIDTH` / `shieldLeft` / `shieldRight` in `lib/client.js` — remove those three and the panel behaves like every other view again.

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
curl -fsSL https://raw.githubusercontent.com/HolynnChen/dsh-plugin-llm-request-gzip/main/install.sh | sh
```

It clones the plugin into `$DSH_HOME/profiles/web/plugins/llm-request-gzip` and appends its loader entry to
`cordis.patch.yml`, leaving an already-registered entry alone — safe to re-run. Target another profile with
`DSH_HOME=... DSH_PROFILE=... sh`.

Then **reload the browser tab** and open **Settings → Plugins → Configuration**.

### Manual install

`DSH_HOME` defaults to `~/.dsh`; the steps below assume the `web` profile.

#### 1. Put the package inside your profile

```bash
git clone https://github.com/HolynnChen/dsh-plugin-llm-request-gzip.git \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web/plugins/llm-request-gzip"
```

No install step is needed for dependency resolution: Node walks up from the plugin directory into the profile's own hoisted `node_modules`, where `@deepseek-ai/schemastery` already lives. If that does not hold for your layout, run `npm install --omit=dev` inside the cloned directory.

#### 2. Register it in the profile's patch layer

`${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml` is a top-level YAML **array** of patch entries. Append:

```yaml
- insert:
    - id: llm-request-gzip
      name: './plugins/llm-request-gzip/lib/index.js'
```

The `name` resolves relative to the profile directory, so a relative path keeps working across machines. An absolute path works too.

> Prefer pnpm-managed installs? `dsh plugin --profile web add github:HolynnChen/dsh-plugin-llm-request-gzip` (requires `pnpm` on `PATH`) installs it into the profile, after which the same entry can use `name: 'dsh-plugin-llm-request-gzip'`.

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

Each route's endpoint is shown next to it. Routes that share one endpoint are grouped, because that endpoint's traffic is compressed as soon as any one of them is enabled.

Settings persist under the `llm-request-gzip` key of `settings.yaml`:

```yaml
llm-request-gzip:
  providers:
    sg:
      enabled: true
      minBytes: 1024
  timing: true
```

### Safety notes

- Every provider is **off by default**.
- Confirm your gateway accepts `content-encoding: gzip` on a provider you can afford to break before enabling it for the provider serving your current session. If the gateway does not support it, that provider's requests will fail.
- If the rewrite itself throws, the plugin falls back to sending the request uncompressed: a bug in this plugin cannot break model requests.

### Confirming it works

The Host logs one line per compressed request:

```
llm-request-gzip: sg request compressed 3043 -> 79 bytes
```

`endpoint-matched` appears instead of a provider name when a request could not be attributed to a provider (see below).

## How provider attribution works

A request URL is all the `fetch` layer sees. When several provider routes share one endpoint — as they do when e.g. `llm-deepseek` and `llm-pi-ai.providers.sg` both point at the same gateway — the URL alone cannot tell them apart, and a per-provider switch would silently behave per-endpoint.

So the plugin hooks the `llm/stream` waterfall and binds the streaming call's provider into an `AsyncLocalStorage` scope. Each iterator resumption runs inside that scope, so the identity survives the adapter's internal `await`s (image serialization, file uploads) and concurrent streams cannot clobber each other. Endpoint matching is only a fallback for requests with no attributed provider, where the longest matching endpoint wins and the policies of the routes on it are OR-ed.

### Why not a dynamic Cordis plugin?

Dynamic plugins run in a `node:vm` sandbox where `fetch` and `require` are trapped to throw, `process` is `undefined`, and there is no zlib, `Buffer`, or `CompressionStream`. Such a plugin can neither compress a body nor reach the realm the adapters fetch from, so this has to be a file-loaded Cordis plugin.

## Uninstall

Delete the `llm-request-gzip` entry from `cordis.patch.yml` (and the cloned directory). The change is live; reload the page and the card is gone.

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
