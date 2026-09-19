# dsh-plugin-llm-request-gzip

Per-provider **gzip request-body compression** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) model calls, configured in the Settings panel.

> 中文文档：[README.zh.md](./README.zh.md)

## What it actually does

This trips people up, so read it first:

| Direction | Default today | This plugin |
| --- | --- | --- |
| Response (downstream) | Node's undici `fetch` **already sends** `accept-encoding: gzip, deflate` and decompresses the reply automatically | Does nothing — there is nothing to enable |
| Request (upstream) | Not compressed; a JSON body carrying a long context and base64 images is uploaded as-is | **Compresses it** and adds `content-encoding: gzip` |

Measured: a 3043-byte chat-completions body becomes 79 bytes.

Both shipped adapters (`dsh-llm-deepseek`, `dsh-llm-pi-ai`) call the global `fetch` directly and the adapter seam exposes no header hook, so this plugin owns that seam for the lifetime of its fiber and restores the original `fetch` when the plugin is stopped or removed.

## Requirements

- DSH with the `web` profile (this plugin ships a browser half for the settings card).
- Node.js >= 20 (bundled with DSH).

## Install

`DSH_HOME` defaults to `~/.dsh`. Everything below assumes the `web` profile.

### 1. Put the package inside your profile

```bash
git clone https://github.com/HolynnChen/dsh-plugin-llm-request-gzip.git \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web/plugins/llm-request-gzip"
```

No install step is needed for dependency resolution: Node walks up from the plugin directory into the profile's own hoisted `node_modules`, where `@deepseek-ai/schemastery` already lives. If that does not hold for your layout, run `npm install --omit=dev` inside the cloned directory.

### 2. Register it in the profile's patch layer

`${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml` is a top-level YAML **array** of patch entries. Append:

```yaml
- insert:
    - id: llm-request-gzip
      name: './plugins/llm-request-gzip/lib/index.js'
```

The `name` resolves relative to the profile directory, so a relative path keeps working across machines. An absolute path works too.

> Prefer pnpm-managed installs? `dsh plugin --profile web add github:HolynnChen/dsh-plugin-llm-request-gzip` (requires `pnpm` on `PATH`) installs it into the profile, after which the same entry can use `name: 'dsh-plugin-llm-request-gzip'`.

### 3. Reload the page

The `web` profile sets `patchReload: live`, so DSH watches `cordis.patch.yml` and re-composes the tree without a restart. **Reload the browser tab** — the client module graph is injected at page load, so an already-open page will not have the card.

Then open **Settings → Plugins → Configuration** and look for **Model request gzip**.

## Configure

One row per provider route:

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

- `test/host.test.mjs` runs the real `apply()` against a fake Cordis context and a spied `globalThis.fetch`, covering schema resolution, the settings hook contract, `llm/stream` attribution, and the fetch rewrite. Its fixture deliberately reproduces the awkward case — two routes sharing one endpoint — to prove the switch is genuinely per-provider.
- `test/client.test.mjs` executes the real browser bundle under a stubbed module loader, asserting that the bundle id matches the package name, that the card lands on the right slot key, and that reads and writes use the correct path operations and revisions.

## Layout

| File | Role |
| --- | --- |
| `lib/compress.js` | Decision core: policy compilation, endpoint index, attribution resolution, gzip plan, header rewriting. No Cordis, globals, or zlib, so it is directly unit-testable. |
| `lib/index.js` | Host half: settings section, `llm/stream` attribution, `globalThis.fetch` patch and restore. |
| `lib/client.js` | Browser half: the settings card. Plain CJS factory contract, no JSX or ESM syntax. |

## License

[MIT](./LICENSE)
