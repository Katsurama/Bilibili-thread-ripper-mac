# BTR Desktop macOS 直播加速可行性分析

> 分析范围：`claude/pensive-mccarthy-dys1v9`（PR #3）以及只读克隆的上游 `MrTangLuyao/Bilibili-thread-ripper`。
> 本阶段只读取源码和文件名，没有运行直播模块、没有访问直播接口、没有执行客户端 JavaScript，也没有修改官方客户端。

## 结论摘要

当前不能确认 macOS 客户端的直播窗口最终加载什么地址，也不能确认它是否会加载 BTR 的 preload。原因是本次没有提供由用户本地解包的 `app.asar`；按照任务边界，没有尝试读取、解码或破解 `main/.biliapp` 等客户端二进制，也没有通过其他途径推断主进程最终 URL。

根据仓库现有代码可以确认：BTR 的 macOS preload 虽然由主进程 bootstrap 挂到 Electron session，但 preload 自身只在 `https://bilipc.bilibili.com/index.html` 和 `https://bilipc.bilibili.com/player.html` 的主 frame 继续执行。若直播窗口是 `live.bilibili.com` 或其他未列出的地址，它不会加载桌面 bundle；若直播窗口只是主窗口里的 `player.html` 或由该页面创建的同源/受允许页面，则仍需 app.asar 和真机页面证据确认。

因此第一阶段的实现结论是：**暂不应强行移植或开启直播加速**。先确认直播窗口 URL 和注入条件；若不能注入，桌面版不能仅靠 `desktop/` 模块实现，替代方案仍是网页版脚本。

## 上游网页版直播模块

本次读取的文件是：

- `upstream-web/src/live-core.js`
- `upstream-web/src/live-hook.js`
- `upstream-web/src/range-core.js`
- `upstream-web/scripts/build.mjs`
- `upstream-web/user_scripts/adapter/meta.json`
- 相关测试：`dev/live-core-test.js`、`dev/live-hook-test.js`、`dev/live-e2e-test.js`

仓库当前分支本身没有 `src/live-core.js` 和 `src/live-hook.js`；它们位于只读克隆的上游网页版目录中。

### `live-core.js`：无 DOM 的纯逻辑

`live-core.js` 自身不读取 DOM，也不发起网络请求。它提供：

- `parseRoomPlayInfo(payload)`：解析 `getRoomPlayInfo` 返回的播放信息，过滤 P2P 地址，整理协议、格式、codec、清晰度和 URL 信息。
- `parseM3u8(text, playlistUrl)`：解析媒体播放列表，识别 `#EXT-X-MAP` 初始化分片、`.m4s` 分片、序号和时长。
- `isLivePlaylistUrl` / `isLiveSegmentUrl`：只识别 `bilivideo.*` 上的 HTTPS `.m3u8` 和 `/live-bvc/…/*.m4s`。
- `isP2pUrl` / `unwrapProxyUrl`：识别 P2P/中继地址，处理 `smtcdns` 包装地址。
- `createHostPool`：对直播 CDN 节点做探测、首字节时间/吞吐排序、短暂阻塞和两次空响应封禁。

它依赖的全局对象只有标准 `URL`、正则和 JavaScript 基础对象；没有 `window` DOM API，也没有播放器 API。

### `live-hook.js`：页面网络钩子和分片缓存

`live-hook.js` 只在 `location.hostname === live.bilibili.com` 时安装（测试环境可显式放宽）。它依赖或使用：

- 全局模块：`__BILI_LIVE_CORE__`、`__BILI_RANGE_CORE__`、可选的 `__BTR_RUNTIME_NOTICES__`。
- 网络 API：`fetch`、`Request`、`Response`、`Headers`、`XMLHttpRequest`。
- 并发/计时 API：`AbortController`、`DOMException`、`performance`、`setTimeout`。
- 页面通信：`postMessage`、`addEventListener("message")`。
- P2P SDK 全局名：`PCDNLoader`、`BPP2PSDK`、`SeederSDK`；直播加速开启时替换为无操作的 mock，避免播放器走 P2P。
- 播放器请求本身通过 `fetch` 或 XHR 进入；模块没有直接依赖特定的 `<video>` DOM 节点，也没有直接调用 MediaSource API。

主要行为：

1. 拦截播放列表 GET 请求，只处理带 `#EXT-X-MAP` 且全部媒体分片为 `.m4s` 的 fMP4 media playlist；master playlist、TS 流不接管。
2. 按播放列表的目录建立一个直播上下文和节点池；对初始化分片以及已公布的直播分片做有限队列预取，通常最多 3 个预取并发。
3. 玩家请求未带 Range 的直播 `.m4s` 时，使用最佳节点并在延迟后对第二节点发起 hedge；完整收齐后以新的 `Response` 返回给播放器。
4. 播放列表宣告的下一片尚未生成时允许有限次数的投机预取；404 被视为“尚未生成”，不是 CDN 永久故障。
5. P2P 或 relay URL 改写为官方 CDN 节点；XHR 只做 URL 改写，不合成完整 XHR 响应。
6. 设置通过 `postMessage` 的 `__BILI_RANGE_ACCELERATOR_V1__` 通道同步；直播开关默认关闭。

### 页面地址和播放器假设

从上游代码和测试只能确认网页版的目标范围：主页面是 `https://live.bilibili.com/<room>`，播放器经常在 `https://live.bilibili.com/blanc/...` iframe 中。上游 userscript 使用匹配规则 `https://*.bilibili.com/*`，并且不设置 `@noframes`；构建器明确让直播域 iframe 继续运行。`dev/live-e2e-test.js` 也只验证网页主页面及其 `live.bilibili.com` iframe。

播放器类型在上游模块中可确认是**特定的 fMP4 HLS media playlist（`.m3u8` + `.m4s`，带 `#EXT-X-MAP`）**。它明确不接管 master playlist 或 TS 流。P2P 在网页版中被认为可能拖慢海外直播，因此直播加速开启时屏蔽 `PCDNLoader`、`BPP2PSDK`、`SeederSDK`；但这只能证明网页版模块的设计和假设，不能证明 macOS 客户端使用同一播放器或开启同一 P2P SDK。

## 当前 macOS 注入条件

### 已确认：bootstrap/preload 的装载方式

- `payload/bootstrap.cjs` 由 `btr_mac.py` 插入客户端 entry，并通过 Electron `session-created` 以及 `app.whenReady()` 给 session 添加普通 preload。
- `payload/preload.cjs` 在 preload 上下文运行，使用 `ipcRenderer` 与主进程通信；维护/更新请求通过 IPC，再用 `window.postMessage` 将结果交给页面 bundle。
- preload 将 `desktop/dist/desktop.js` 作为页面 `<script>` 注入，而不是通过 Node `require` 把桌面 bundle 放进 renderer。
- `desktop/tools/build.cjs` 只把 `desktop/shared/` 和 `desktop/src/` 的文件拼进 `desktop/dist/desktop.js`；当前没有直播模块文件。

### 已确认：当前页面范围

`payload/preload.cjs` 的第一道条件是：

```js
if (!process.isMainFrame
    || location.origin !== "https://bilipc.bilibili.com"
    || !/^\/(index|player)\.html$/.test(location.pathname)) return;
```

`payload/maintain.cjs` 的 IPC 信任判断也只接受同一 origin 的 `/index.html` 和 `/player.html`。桌面 bundle 的 `desktop/src/transport.js` 还会把 `bilipc.bilibili.com` 的非 `/player.html` 页面排除在视频下载接管之外。

这意味着：即使 bootstrap 已成功挂载到某个 Electron session，当前 preload 也不会在任意 `live.bilibili.com` 页面或任意其他直播窗口地址注入 bundle。

## 必须标注的判断

| 问题 | 结论 | 依据 |
|---|---|---|
| 直播窗口最终加载的 URL（去掉查询参数） | **未知** | 未提供用户本地解包的 `app.asar`；按边界未搜索或解码 `main/.biliapp`，也未通过客户端运行时或远程调试端口推断。仓库源码只有 `openLiveRoomWindow` 的背景描述，没有该调用的可读实现。 |
| 直播窗口是否会加载 `payload/preload.cjs` | **推测：大概率不会，但尚未确认** | bootstrap 会给 session 添加 preload，但 `payload/preload.cjs` 只接受 `bilipc.bilibili.com/index.html`、`/player.html` 的主 frame。只要直播窗口最终地址不是这两个路径，代码会立即 return。最终地址未知，所以不能升级为已确认。 |
| 直播播放器类型 | **网页版：已确认；macOS 客户端：未知** | 上游 `live-core.js`/`live-hook.js` 只接管带 `#EXT-X-MAP` 的 fMP4 HLS（`.m3u8` + `.m4s`），跳过 TS/master；桌面客户端没有提供可读直播窗口源码或网络证据。 |
| P2P 是否开启 | **网页版：模块开启时会屏蔽；macOS 客户端：未知** | 上游 hook 替换 `PCDNLoader`、`BPP2PSDK`、`SeederSDK`；这不是客户端实现的证据。 |
| `desktop/shared/cdn-resolver.js` 能否直接复用 | **部分逻辑可复用，不能直接复用为直播模块** | 它面向 Bilibili 媒体文件和 Range 下载地址，支持 `.m4s/.mp4/.flv` 的媒体 URL 与 CDN 节点候选；当前没有直播 `.m3u8` 解析、直播上下文、初始化分片、分片生成中的 404 语义或整片 hedge 调度。 |
| `desktop/shared/idm-downloader.js` 能否直接复用 | **不能直接复用；可复用调度思想/底层安全约束** | 它的核心输入是带 `Range` 的点播媒体请求，并把大范围切成多个 byte ranges；直播模块需要对每个完整 `.m4s` 做有限并发、首字节超时、双节点 hedge 和预取。两者请求模型不同。 |

## 第一阶段方案建议（尚未实现）

### 如果 app.asar 证明直播窗口可注入

建议把实现拆成只在直播页面生效的模块：

- **原样复用或提取**：`live-core.js` 的播放列表解析、P2P URL 判定/解包、节点池逻辑；`range-core.js` 的安全 URL/响应范围解析工具；设置的 `liveEnabled` 默认关闭语义。
- **改写**：把 `live-hook.js` 的 fetch/XHR 钩子、fMP4 分片缓存、有限预取、hedge 下载和 P2P SDK 屏蔽改成桌面 bundle 可加载的模块；不能把它当作点播 Range 请求交给 `idm-downloader.js`。
- **注入门槛**：先扩大 preload 的允许页面范围到经过 app.asar 确认的直播 origin/path，并同时扩大 `maintain.cjs` 的信任判断（若直播页面需要 IPC）；不能只把设置开关改为可勾选而不确认注入。
- **设置同步**：复用桌面 `localStorage`/`BroadcastChannel` 设置，新增或保留 `liveEnabled` 的读写；直播窗口与设置页必须验证是否属于同一 storage partition。
- **失败策略**：直播 playlist 不是 fMP4、请求带 Range、节点返回不完整、模块安装失败或上下文切换时，必须交回客户端原始请求，不改变官方播放器的播放流程。

### 如果 app.asar 证明不能注入

不要强行修改 `desktop/` 或 preload 去猜测窗口 URL。桌面版只能继续显示“直播加速（敬请期待）”，并在文档中说明：当前注入范围不覆盖直播窗口；可用替代方案是使用网页版 BTR userscript，在 `live.bilibili.com` 主页面和其播放器 iframe 中运行。除非未来客户端提供受支持的扩展/注入入口，否则不应通过修改官方二进制或绕过签名来实现。

## 后续验证方法

### 只读客户端分析（需要用户提供材料）

1. 用户在本机将客户端 `app.asar` 解包到一个新目录，并只提供该解包目录路径；不要提供账号、Cookie、视频地址或签名 URL。
2. 在该目录中搜索 `openLiveRoomWindow`，只记录命中文件名、附近的可读代码和最终页面的域名/路径；若相关文件是不可读二进制，停止并标记未知。
3. 用确认的 URL 对照 `payload/preload.cjs` 的 origin/path/main-frame 条件，得出注入结论。
4. 如果需要确认播放器类型，只读取已解包的可读页面脚本中的静态字符串和请求路径；不要执行客户端脚本，不要向 Bilibili 发起批量请求。

### 真机测试（只有用户另行明确同意安装后）

1. 在安装前保留官方客户端备份，不修改或删除备份目录。
2. 安装测试前确认直播开关默认关闭；打开直播窗口，验证是否实际加载了 BTR 的可观测设置/调试标记。
3. 开启直播加速后，仅使用一个手动选择的普通直播间观察：播放器是否继续播放、是否出现 fMP4 playlist 和 `.m4s` 分片、节点是否有健康/失败状态、是否发生 P2P SDK 请求。
4. 比较关闭/开启直播加速时的首片等待、连续播放时间、重连/切换清晰度行为；至少覆盖直播切换、窗口关闭、网络短暂失败和非 fMP4/TS 回退。
5. 任一启动卡住或播放失败时，先停止测试，不反复重启；只收集用户明确同意范围内的本地日志，并按要求脱敏家目录、用户名和 URL。

## 未验证项

- macOS 客户端直播窗口的最终 URL 和是否使用独立 BrowserWindow/session。
- 直播窗口是否加载 `payload/preload.cjs`。
- macOS 客户端实际直播播放器是 fMP4 HLS、FLV、TS 还是其他协议。
- macOS 客户端是否启用 P2P SDK，以及其全局对象/请求接口。
- 桌面版直播窗口与设置页是否共享 `localStorage`/`BroadcastChannel` storage partition。
- 任何真实直播播放效果、节点速度、预取命中率或卡顿改善。

## 第二阶段方案设计（仅方案，不实现）

PR #3 已合并；本节是在同一工作分支上补充的后续方案设计。由于直播窗口 URL 和注入条件仍未由 `app.asar` 静态材料确认，本方案采用“先验证门槛、再启用模块”的两阶段闸门，不通过猜测 URL 来注入。

### A. 注入条件确认后的实现结构

如果用户提供的解包 `app.asar` 证明直播页面是可注入的，建议按以下边界实现：

1. **注入 allowlist**
   - `payload/preload.cjs` 保留现有 `bilipc.bilibili.com/index.html`、`/player.html` 规则。
   - 仅增加由静态分析确认的直播 origin/path；如果播放器在 `live.bilibili.com/blanc/...` iframe 中，则允许 live 域的主 frame 和 live 域子 frame，但仍拒绝其他 Bilibili iframe。
   - `process.isMainFrame` 不能继续无条件挡住已确认的 live iframe；必须改为“主 frame 或确认的 live 域 frame”。
   - 不扩大 `payload/maintain.cjs` 的 IPC 信任范围，除非直播 frame 确实需要维护/更新 IPC；直播播放本身不应拥有更新、卸载或打开外链能力。

2. **bundle 分层**
   - 新增 `desktop/shared/live-core.js`：移植上游 `src/live-core.js` 的纯逻辑，保持无 DOM、无网络副作用，使用桌面项目的命名和测试约定。
   - 新增 `desktop/shared/live-hook.js`：只在确认的直播页面安装，负责 playlist 观察、P2P URL 改写、完整 `.m4s` 下载竞速和有限预取。
   - `desktop/tools/build.cjs` 将两个文件加入 bundle；点播的 `transport.js` 和 `idm-downloader.js` 不负责直播请求。
   - `desktop/src/client.js`、播放器扫描和点播 XHR/fetch 接管逻辑在直播页面必须继续 no-op，避免把直播 `.m3u8` 或整片 `.m4s` 当点播 Range 请求。

3. **设置同步**
   - 不能假设 `bilipc.bilibili.com` 与 `live.bilibili.com` 共享 `localStorage` 或 `BroadcastChannel`；它们是不同 origin。
   - 设置页继续把 `liveEnabled` 持久化在现有桌面设置中，并通过受信 preload 的窄 IPC 通道向主进程发布设置快照。
   - 直播 frame 只允许调用“读取当前设置/订阅设置变化”的 IPC；主进程按 `senderFrame` URL 校验后返回 `{enabled, liveEnabled, mode, customHosts, ...}`，不暴露维护操作。
   - 若直播窗口与 bilipc 页面实际属于同一 origin，则可以复用现有 storage 事件；在未验证前不采用这个假设。

4. **直播下载行为**
   - 原样复用上游的纯逻辑：`parseM3u8`、`isLivePlaylistUrl`、`isLiveSegmentUrl`、P2P/relay URL 判定、节点池的健康排序和短暂封禁。
   - 改写为桌面环境的 `fetch`/XHR hook：保留播放器提供的 headers、credentials 和 abort signal；不添加账号、Cookie 或签名 URL 的日志。
   - 只处理 fMP4 HLS：带 `#EXT-X-MAP` 的 `.m3u8` 以及 `.m4s` 分片。master playlist、TS/FLV 或无法验证完整长度的响应交回官方请求。
   - 预取队列最多 3 个普通分片，播放器等待时降为 1 个；第二节点只在 hedge 延迟后启动。上下文按 playlist 目录切换，换房间/清晰度时取消旧上下文。
   - P2P SDK 屏蔽必须限定在直播模块开启且页面为确认的直播页面；关闭开关、模块异常或播放器类型不匹配时恢复原对象/原请求。
   - 节点只接收经过现有 Bilibili media-host 校验的地址；不允许自定义任意域名，也不输出完整带签名 URL。

5. **设置界面**
   - 把当前 disabled 的“直播加速（敬请期待）”改为可勾选的“直播加速（实验性）”，默认 `false`。
   - 保留明确的回退说明：只支持确认的 fMP4 直播流；不支持时由客户端原生播放。
   - `liveEnabled` 的 schema、默认值、升级归一化和设置广播必须在设置页、直播 frame、bundle 三处一致。
   - 因为改动会进入客户端，任何实现提交都必须同时升级 `mac-version.json`，并重新提交 `desktop/dist/desktop.js`。

### B. 如果确认不能注入

如果解包材料显示直播窗口使用不受 preload 覆盖的 origin/path，或播放器在独立 session 中无法获得安全的设置 IPC，则不实现桌面直播加速：

- 保持开关灰色或继续显示“敬请期待”，避免给用户造成已生效的假象。
- 不修改官方 app 二进制，不绕过签名、完整性检查或安全策略。
- 文档说明网页版方案是当前唯一可支持的路径：上游 userscript 可在 `live.bilibili.com` 主 frame 和 `blanc` iframe 中运行。
- 只有客户端未来提供受支持的扩展入口，或提供可确认的直播 preload 加载路径后，才重新评估桌面实现。

### C. 测试设计

不使用真实直播服务器做默认测试，不保存账号、Cookie、播放地址或签名 URL。建议测试层次如下：

1. **`node --test` 纯逻辑测试**
   - 用 `vm` 加载 `desktop/shared/live-core.js`。
   - 覆盖 playinfo 扁平化、P2P/relay 识别、m3u8 相对 URL、初始化分片、序号和 TS/master 拒绝。
   - 覆盖节点池的探测状态、首字节排序、短暂阻塞、两次空响应封禁和恢复。

2. **离线 hook harness**
   - 用假的 `fetch`、`Response`、`ReadableStream`、XHR 和计时器加载真实 `live-hook.js`。
   - 验证：播放器请求命中缓存、缓存 miss 触发 urgent 下载、hedge 取消慢副本、预取 404 不封禁节点、响应长度不符回退、Abort 不留下旧上下文。
   - 验证 P2P 全局对象只在 `liveEnabled=true` 时被 mock，关闭后恢复原对象。

3. **桌面浏览器 fixture**
   - 在现有 `desktop/test/browser.cjs` 增加离线 live fixture，而不是导航到真实直播间。
   - 验证设置默认关闭、跨页面设置变化、直播页面不触发点播 Range downloader、非直播页面行为不变。
   - 验证没有 `.m3u8`/`.m4s` 时 bundle 无新增网络请求。

4. **真机安装前检查**
   - 先用用户提供的 `app.asar` 解包目录完成 URL/注入确认。
   - 再构建并运行全部桌面单元测试；每次实现提交都记录构建版本和通过数。
   - 只有用户再次明确同意后，才运行安装脚本做真机直播验证；默认不安装、不改 `/Applications`。

### D. 真机验证清单（未来实现后）

- 设置页：开关默认关闭，打开后状态在直播窗口可见；关闭后不再接管新分片。
- 播放器：覆盖 fMP4 直播、TS/FLV 回退、切换清晰度、切换直播间、关闭窗口和网络短暂失败。
- 性能：记录首片等待、连续播放时长、预取命中率、hedge 次数和健康节点数；只记录脱敏的节点 host，不记录完整 URL。
- 安全：确认不请求未允许的 host，不把签名 URL 发送到日志/IPC，不改变官方应用文件和签名。
- 失败处理：若启动界面卡住或播放异常，停止测试，不反复重启；按用户明确授权范围收集本地文件列表和脱敏日志。
