# dsh-plugin-llm-request-gzip

按提供方（provider）为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的模型请求启用 **gzip 请求体压缩**，并在设置面板中配置。

> English docs: [README.md](./README.md)

## 它到底做什么

这里有个容易误解的点，先看表格：

| 方向 | 现状 | 本插件 |
| --- | --- | --- |
| 响应（下行） | Node 的 undici `fetch` **已经默认发送** `accept-encoding: gzip, deflate`，并自动解压响应 | 不做任何事——没有可开启的东西 |
| 请求（上行） | 默认不压缩；长上下文 + base64 图片的 JSON body 原样上传 | **压缩它**，并加 `content-encoding: gzip` |

实测：一个 3043 字节的 chat-completions body 压缩后为 79 字节。

DSH 的两个 adapter（`dsh-llm-deepseek`、`dsh-llm-pi-ai`）都直接调用全局 `fetch`，适配器 seam 没有 header 钩子，
因此本插件在自身 fiber 生命周期内接管该 seam，并在插件停止或移除时还原原始 `fetch`。

## 环境要求

- 使用 `web` profile 的 DSH（浏览器半边用于渲染设置卡片）。
- Node.js >= 20（DSH 自带）。

## 安装

### 一行命令

```bash
curl -fsSL https://raw.githubusercontent.com/HolynnChen/dsh-plugin-llm-request-gzip/main/install.sh | sh
```

脚本会把插件克隆到 `$DSH_HOME/profiles/web/plugins/llm-request-gzip`，并把装载条目追加到 `cordis.patch.yml`；
若该条目已存在则保持原样，可重复执行。指定其它 profile：`DSH_HOME=... DSH_PROFILE=... sh`。

之后**刷新浏览器页面**，打开 **设置 → 插件 → 配置**。

### 手动安装

`DSH_HOME` 默认为 `~/.dsh`，以下均以 `web` profile 为例。

#### 1. 把包放进 profile

```bash
git clone https://github.com/HolynnChen/dsh-plugin-llm-request-gzip.git \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web/plugins/llm-request-gzip"
```

依赖解析无需额外安装步骤：Node 会从插件目录逐级向上查找，命中 profile 自己已 hoist 的 `node_modules`，
`@deepseek-ai/schemastery` 就在那里。若你的目录结构不符合，在克隆目录内执行 `npm install --omit=dev` 即可。

#### 2. 在 profile 的 patch 层注册

`${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml` 是一个顶层 YAML **数组**。追加：

```yaml
- insert:
    - id: llm-request-gzip
      name: './plugins/llm-request-gzip/lib/index.js'
```

`name` 相对 profile 目录解析，因此相对路径换机器也能用；写绝对路径同样可以。

> 更喜欢用 pnpm 管理？`dsh plugin --profile web add github:HolynnChen/dsh-plugin-llm-request-gzip`
> （需要 `pnpm` 在 `PATH` 上）会把它装进 profile，之后同一行可以写成 `name: 'dsh-plugin-llm-request-gzip'`。

#### 3. 刷新页面

`web` profile 的 `patchReload` 为 `live`，DSH 会监听 `cordis.patch.yml` 并实时重排组合，**不需要重启**。
但必须**刷新浏览器页面**——客户端模块图是在页面加载时注入的，已打开的页面拿不到新的 bundle。

然后打开 **设置 → 插件 → 配置**，找到 **模型请求 gzip 压缩**。

## 配置

每个提供方路由一行：

- **开关**：该提供方的模型请求是否压缩。
- **最小压缩体积（字节）**：默认 `1024`。更小的请求原样发送；压缩后若没有真正变小也会放弃压缩。

每行会显示该路由的 endpoint。共用同一 endpoint 的路由会被归为一组，因为只要其中任意一个被启用，
该 endpoint 的流量就会被压缩。

设置持久化在 `settings.yaml` 的 `llm-request-gzip` 段：

```yaml
llm-request-gzip:
  providers:
    sg:
      enabled: true
      minBytes: 1024
```

### 安全提示

- 所有提供方**默认关闭**。
- 请先在一个「坏了也无所谓」的提供方上确认你的网关接受 `content-encoding: gzip`，再对正在服务当前会话的提供方开启。
  若网关不支持，该提供方的请求会直接失败。
- 重写逻辑本身抛错时会回退为不压缩发送：插件的 bug 不会打断模型请求。

### 确认生效

Host 会为每次压缩输出一行日志：

```
llm-request-gzip: sg request compressed 3043 -> 79 bytes
```

当请求无法归属到具体提供方时（见下），日志里显示的是 `endpoint-matched` 而不是提供方名。

## 提供方归属是如何判定的

`fetch` 这一层只能看到请求 URL。当多个提供方路由共用一个 endpoint 时——例如 `llm-deepseek` 与
`llm-pi-ai.providers.sg` 都指向同一个网关——单靠 URL 无法区分，此时「按提供方」的开关会悄悄退化成「按 endpoint」。

因此插件挂到 `llm/stream` waterfall 上，把该次流式调用的 provider 绑定进 `AsyncLocalStorage` 作用域。
每次迭代器恢复都在该作用域内执行，所以这个身份能穿过 adapter 内部的 `await`（图片序列化、文件上传），
并发流之间也不会互相污染。只有在完全拿不到归属信息时才退化为 endpoint 匹配：取最长匹配的 endpoint，
并把其下路由的策略取并集。

### 为什么不是动态 Cordis 插件？

动态插件运行在 `node:vm` 沙箱中，`fetch` 与 `require` 被拦截为抛错，`process` 为 `undefined`，
也没有 zlib、`Buffer` 或 `CompressionStream`。它既无法压缩请求体，也够不到适配器实际使用的那个 realm，
所以本功能必须由文件加载的持久化 Cordis 插件承担。

## 卸载

删除 `cordis.patch.yml` 中的 `llm-request-gzip` 条目（以及克隆的目录）。改动实时生效，刷新页面后卡片消失。

## 测试

```bash
npm test
```

- `test/host.test.mjs`：用假 Cordis context + 被监视的 `globalThis.fetch` 跑通真实 `apply()`，
  覆盖 schema 解析、settings 钩子契约、`llm/stream` 归属与 fetch 重写。其 fixture 特意复现
  「两个路由共用一个 endpoint」这一棘手场景，用来证明开关确实是按提供方生效的。
- `test/client.test.mjs`：在 stub 的模块加载器下执行真实浏览器 bundle，验证 bundle id 与 package name 一致、
  卡片落在正确的 slot key 上，以及读写的路径操作与 revision 正确。

## 结构

| 文件 | 作用 |
| --- | --- |
| `install.sh` | 一行命令安装器：克隆到 profile 并注册到 `cordis.patch.yml` |
| `lib/compress.js` | 决策核心：策略编译、endpoint 索引、归属解析、gzip 计划、header 改写。不依赖 Cordis / 全局对象 / zlib，可直接单测 |
| `lib/index.js` | Host half：settings 段、`llm/stream` 归属、`globalThis.fetch` 补丁与还原 |
| `lib/client.js` | 浏览器 half：设置卡片。CJS factory 合约，纯 JS，无 JSX / ESM |

## 许可

[MIT](./LICENSE)
