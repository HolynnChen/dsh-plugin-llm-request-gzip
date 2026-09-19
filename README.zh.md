# dsh-plugin-llm-request-gzip

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的模型请求提供两件事：

- **按提供方的 gzip 请求体压缩**，在 设置 → 插件 中配置。
- **请求耗时分解** —— 与「轨迹」并列的一个视图，把每次模型调用拆成各阶段，并给出每秒 token 数。

> English docs: [README.md](./README.md)

## gzip：它到底做什么

这里有个容易误解的点，先看表格：

| 方向 | 现状 | 本插件 |
| --- | --- | --- |
| 响应（下行） | Node 的 undici `fetch` **已经默认发送** `accept-encoding: gzip, deflate`，并自动解压响应 | 不做任何事——没有可开启的东西 |
| 请求（上行） | 默认不压缩；长上下文 + base64 图片的 JSON body 原样上传 | **压缩它**，并加 `content-encoding: gzip` |

实测：一个 3043 字节的 chat-completions body 压缩后为 79 字节。

DSH 的两个 adapter（`dsh-llm-deepseek`、`dsh-llm-pi-ai`）都直接调用全局 `fetch`，适配器 seam 没有 header 钩子，
因此本插件在自身 fiber 生命周期内接管该 seam，并在插件停止或移除时还原原始 `fetch`。

## 请求耗时分解

会话视图切换器里，「请求耗时」与「轨迹」并列（只要上面的开关是开启的）。它按时间倒序列出当前会话的每次模型请求，并把每次调用拆开：

```
流开始 ──▶ fetch() ──────▶ 请求体发送完毕 ──────▶ 首个 token ──────▶ 结束
   │          │                  │                    │              │
   │       准备             发送           首 token     │          生成
   │                            └──── 服务端 ────┘     │              │
   └──────────────────────── 总计 ───────────────────────────────────┘
```

| 列 | 含义 |
| --- | --- |
| 时间 | 请求发出的时刻，精确到秒。 |
| 提供方 / 模型 | 提供方路由、模型、用途（压缩/标题）；请求体确实被压缩时带 `gzip` 标记，运行中或失败也有标记。 |
| 发送 | 请求发出 → **请求体全部发送完毕**。 |
| 服务端 | 发送完毕 → 收到响应头。 |
| 首token | 等到首个 token 用了多久：普通请求从**发出**算起，预热请求从**被领用**算起。服务端自身的首 token（从发送完毕起算）在行的悬停提示里。 |
| 生成 | 首个 token → 流结束。 |
| tok/s | 输出 token 数 ÷ 生成区间。 |
| 缓存 | 提示词中由提供方前缀缓存直接命中的比例。`inputTokens` 只统计**未缓存**的输入，因此提示词是「缓存 + 未缓存」，比例为 缓存 ÷（缓存 + 未缓存）；悬停可看原始 token 数。 |
| 请求体 | 被 gzip 压缩时显示 `压缩前 → 实际发送`，否则只显示序列化后的大小。 |
| 响应体 | **线路上**实际收到的字节数，并在响应声明了 `content-encoding` 时一并标出——因此 gzip 返回会被明确标记，而不只是「看起来小」。显示 `–` 表示**一个字节都没归属到本行**，那是接线故障而不是空响应。 |
| 总计 | 发出请求 → 流结束。 |

每个表头字段把鼠标移上去都会给出解释；把鼠标停在某一行上，还能看到塞不进表格的细节：准备耗时（流开始 → 请求发出）、输入/输出 token 数，以及响应体积及其编码。

表格用**固定列宽占比**铺满面板——提供方/模型这一列拿最大占比，数值列只拿其取值所需的宽度——所以既不会在右边留一大片空白，也不会把最长的那个值撑成一列。

会话列自身的宽度拖拽手柄属于外壳（shell），只要会话处于 active 它对**每个**视图都会渲染，视图无法让它不渲染——但它带有一个稳定的 `data-width-handle` 属性。本视图挂载期间会插入一条样式规则 `[data-width-handle]{display:none}`，卸载时移除：于是表格上误拖不会改变列宽，而其它视图仍保留手柄。面板打开时还会请求外壳的滚动容器把它带到顶部——否则从正在对话的（滚到底部的）页面切过来会停在底部。表格在面板内滚动，表头钉在该框顶部。面板会实测自己下方真正剩下的空间——自身顶部位置、外壳公布的 `--dsh-composer-height`、再加一点边距——并据此限定自身高度，因此它能一屏放下，外壳那层滚动条也不会再同时出现。之所以要实测而不能靠 `height:100%`：会话处于 active 时外壳给视图区的是 `auto` 高度。这两件事都在 `lib/client.js` 中 `TimingView` 顶部的那两个挂载 effect 里；删掉它们，面板就恢复成和其它视图一样。

### 前缀复用

长对话请求里 prefill 占大头，而其中真正值得省的是共享前缀。这种复用是**服务端**机制——提供方对提示词前缀做哈希并复用已算好的 KV 缓存——所以客户端唯一能做的杠杆就是让前缀逐轮保持字节级稳定，而 DSH 已经做到了。「缓存」这一列就是用来看它有没有生效：它读的是提供方自己的账，比例高就说明 prefill 基本被跳过了。

也值得知道为什么那个看起来很自然的客户端思路——先用已知前缀开一个请求、等工具跑完再把剩下的接上去——帮不上忙：OpenAI 兼容的 `/chat/completions` 请求体是**一个 JSON 文档**，端点在请求体完整之前只会缓冲、不会开始推理，所以只发前缀不会启动任何计算，而且已发出的请求也无法追加。那个投机请求要么被丢弃（什么都没做），要么一直挂着直到超时。这件事交给服务端做，客户端把前缀保持稳定即可。

### 为什么和「轨迹」里的 TTFT 不一样

轨迹自带的耗时面板是从 **step 开始**算 TTFT 的（`firstTokenTime - stepStartTime`），把请求体序列化和发送都算进了等待里。
轨迹是内置 bundle，那个面板没有暴露扩展点，所以本分解做成独立视图；而其中的「发送」边界正是轨迹无法展示的部分。

### 怎么测的，以及为什么没有估算

「发送」取自 undici 自己的 `undici:request:bodySent` 诊断——传输层写完请求体的那一刻；「服务端」取自 `undici:request:headers`；响应字节数取自 `undici:request:bodyChunkReceived`，它是**线路字节**。
三者都通过 `node:diagnostics_channel` 消费，因此**测量本身完全不改动请求**：请求体保留 `content-length`，也不会被改成 chunked 编码。

这些 channel 是进程级的，而且响应侧那几个还是**按 socket 归属的**：在 keep-alive 复用连接上，它们会运行在最早打开该 socket 的那个请求的异步上下文里。
在那里读环境上下文，会把 `headers` 归属到一个更早、已经结束的请求上——这正是「朴素实现只在每条连接的第一个请求上报服务端耗时、之后全是 null」的原因。
本插件在 `undici:request:create`（它仍在调用方上下文里）把测量与 undici 的 request 对象配对，之后的诊断一律按该对象身份查找，因此复用连接的请求不会丢阶段。
`test/host.test.mjs` 会在同一条连接上连续发 4 个请求来断言这一点，一旦把配对改回按上下文归属，该测试就会失败。

测量数据保存在 Host 内存中（每会话最近 100 条、最近 40 个会话），通过产品自身的 `/api` 鉴权路由提供给页面。它不持久化，因此 DSH 重启后不再保留。

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

> **更新已安装的副本。** `patchReload: live` 监听的是 `cordis.patch.yml`，**不监听插件源码**，所以改过的 Host 半边必须重启 `dsh web` 才会生效。
> 浏览器 bundle 不同：它会被重新从磁盘读取，因此客户端半边只要刷新页面即可。拿不准时两个都做。

## 配置

卡片位于 **设置 → 插件 → 配置**，和该页面其它插件卡片一样**默认折叠**。展开后可以看到：

**插件级开关**

- **展示「请求耗时」面板**：默认开启。关闭后 Host 也不再记录耗时，因此不需要这个面板的部署不会有任何额外开销。
  视图标签会立即出现/消失，无需刷新页面。

**每个提供方路由一行**

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
      prewarm: true
  prewarmHoldMs: 120000
  prewarmPoolSize: 3
  timing: true
```

### 预传输（按提供方开关，默认关闭）

多轮对话每走一步都会把整段历史重发一遍。对某个提供方开启 **预传输** 后，插件会为每个会话维护一个**预发请求池**，在需要它的请求还没出现之前就把共享历史放到线上——因为很长的历史不会瞬间到达对端，前缀越长，中转链路把它送过去就越久。

每个会话的池里有 `prewarmPoolSize` 条成员（默认 `3`）。成员在不同时刻打开、并**随着内容逐步可知而持续推进**，因此被消费的那条通常已经在途了好几步，而不是只有一步：

- **打开**：一次模型调用发出，它自带的历史就已确定；把所有成员推进到该前缀，并把池补满。推进用的是刚刚捕获到的请求的**字节切片**，从不重建。
- **填充**：一步以「需要调用工具」结束，于是在工具执行期间把助手这一轮追加进每个成员。这段字节**是**对 adapter 序列化的预测，因此有防护：捕获到的 body 必须能原样通过 `JSON.parse`/`JSON.stringify` 往返，且上一个助手轮只能使用可推理的字段、并具有相同形态（有无 tool calls 要一致）。预测错了会在下一个请求认领时被**逐字节**发现——随后该提供方的填充会被关闭，池退回只靠捕获字节推进。
- **消费**：下一个请求认领**最老**的那条——只要它的字节能被该请求延续、且请求头仍然一致；其余成员被推进，池再补满。
- **销毁**：一步以**非** `tool-calls` 结束（`stop`、`max-tokens`、报错、中断）时没有后继，整个池立即释放；历史无法延续的会话、以及持有超时的成员也一样。

被持有的成员使用 chunked 请求体，因为在增量出现之前无法知道长度。若该 endpoint 返回异常——或拒绝 chunked 请求体——预传输会在本进程内对该 endpoint 关闭；其中「形状类」拒绝（411/415/501）会立即按普通请求重发。

用上它的行会带 **预热** 标记，悬停可以看到预发字节数、增量字节数，以及该成员被持有（在途）了多久。最后这个数字就是**实际赢得的提前量**，也是判断「加长池子在这条链路上到底值不值」的诚实依据。

gzip 与预传输可以并存：切分时保持**同一个 deflate 流**不关闭，因此各段能作为**一个整体**解压，压缩不会因为预传输而被牺牲。

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
  「两个路由共用一个 endpoint」这一棘手场景，用来证明开关确实是按提供方生效的。它还会端到端测量一次**真实**请求：
  本地 SSE 端点把思考时间、首 token 延迟、解码窗口刻意分开，再经插件真实的传输层诊断跑一遍。
- `test/client.test.mjs`：在 stub 的模块加载器与**会追踪 hook 的 React 替身**下执行真实浏览器 bundle，
  因此可以真正渲染卡片、点击它、再重新渲染：验证 bundle id 与 package name 一致、卡片注册在 settings 命名空间上且**默认折叠**、
  耗时开关写入顶层字段、以及耗时视图只在开关开启时注册——包括「首个 section 到达前不做决定」和「随开关变化增删」。
- `test/timing.test.mjs`：用注入时钟驱动阶段运算，每个边界都精确到毫秒断言，含「某个阶段确实不存在」的情形。

## 结构

| 文件 | 作用 |
| --- | --- |
| `install.sh` | 一行命令安装器：克隆到 profile 并注册到 `cordis.patch.yml` |
| `lib/compress.js` | gzip 决策核心：策略编译、endpoint 索引、归属解析、gzip 计划、header 改写。不依赖 Cordis / 全局对象 / zlib，可直接单测 |
| `lib/timing.js` | 耗时状态机：阶段边界、吞吐、每会话环形缓冲、脱敏的线上投影。对注入时钟是纯函数 |
| `lib/index.js` | Host half：settings 段、`llm/stream` 归属、耗时测量及其鉴权 `/api` 路由、`globalThis.fetch` 补丁与还原 |
| `lib/client.js` | 浏览器 half：设置卡片与请求耗时视图。CJS factory 合约，纯 JS，无 JSX / ESM |

## 许可

[MIT](./LICENSE)
