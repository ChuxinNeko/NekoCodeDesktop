# NekoCode 交接说明

给接手这个项目的 AI。读完再动手。作者是 moraxs，沟通用中文。

---

## 0. 这是什么

`NekoCodeDesktop` 是一个 Electron 桌面编码 agent（基于 in-tree 的 PI agent core），另有：

- `mobile/` — Capacitor 手机 APP，和根目录共用 `package.json`
- `server/` — **独立** Node/Bun 后端（ElysiaJS + MongoDB），**不在 workspaces** 里，有自己的
  `package.json` 和 `node_modules`

最近这一轮工作完成了三件事：QQ 机器人接入、账号体系含密码重置、以及**独立的公网
relay**——桌面和手机登录同一 NekoCode 账号后通过服务端中转端到端密文通信，和局域网配对是
两套完全独立、各自可选的连接模式。**代码已完成，离上线最大的剩余是部署 + 真实联调 +
账号注销。**

---

## 1. 先记住这几条，否则一定会踩

1. **`pi/` 是上游快照，不要改。** 所有修复写在 `src/main/`，改 `pi/` 会在下次同步时消失。
2. **主进程打包成 CJS，但有些依赖是纯 ESM。** Rollup 会把外部包的 `import()` 改写成
   `require()`。Electron 44 带 Node 24.20，`require(esm)` 大多能用；但**有顶层 await 的包会
   炸**。已有的规避手段在 `src/main/qqbot/official.ts`：
   ```ts
   const esmImport = new Function("specifier", "return import(specifier)") as ...
   ```
   加新的 ESM-only 依赖到主进程时照抄这个。
3. **`capturePage()` 在 `offscreen: true` 的窗口上会抛 `UnknownVizError`。** 用普通隐藏窗口
   （`show: false` + `paintWhenInitiallyHidden: true`）。见 `src/main/qqbot/code-image.ts`，
   那里有实测过的可用写法。
4. **正则里 `\b` 对中文无效。** `\b` 只在 `[A-Za-z0-9_]` 边界成立，`/配对\b/` 永远不匹配。
   这个 bug 曾让所有中文配对指令静默失效。
5. **改完必须全绿**（下面都要过）：
   ```bash
   ./node_modules/.bin/tsc --noEmit -p tsconfig.json    # 根：桌面 + mobile
   bun test src scripts mobile/src                      # 265 passed
   bun run build                                        # electron-vite
   bun run mobile:build                                 # 成功；chunk >500kB 是 warning 不是失败
   cd server && ./node_modules/.bin/tsc --noEmit && bun test   # 50 passed
   ```
   注意用 `./node_modules/.bin/tsc`，`npx tsc` 在这个仓库会报错。

---

## 2. 已完成的部分

### 2.1 QQ 机器人（桌面端，可用）

`src/main/qqbot/` + `src/shared/qqbot.ts` + 设置页 `ConnectSettings/QqBotSettings/QqBotDialog`。

- 双协议：OneBot v11（自建 NapCat 等）和 QQ 官方开放平台
- 官方平台用官方 SDK `@tencent-connect/qqbot-nodejs`（MIT）。
  **不要引入 `@tencent-connect/qqbot-connector`** —— 它是 `UNLICENSED` 且混淆过的
- 配对码授权（不是手填白名单），未配对的聊天静默忽略
- 流式回复、按钮（工作流提问 + 停止任务）、图片/文件/语音收发、引用上下文
- 代码块和表格渲染成图片（shiki + Electron 截图，本地渲染，源码不出本机）
- Markdown 压平：QQ 群聊/私聊的自定义 Markdown 已对所有机器人开放**无需申请**，但
  **不支持代码块、行内代码、表格**，所以即使开启 Markdown 也要压平这三样
- 聊天指令：`/new` `/stop` `/status` `/undo` `/model` `/think` `/setdir`

**状态**：用户确认能正常收发消息。流式、按钮、附件的**真机效果未验证**。

### 2.2 手机 APP 局域网连接（早已可用）

`src/main/lan-service.ts`（桌面端 HTTP 服务，默认端口 47832）+ `mobile/src/lan-client.ts`。
扫码或手动配对，配对码 10 位十六进制、5 分钟、一次性。**LAN 配对只属于局域网模式，公网
relay 完全不使用它。**

### 2.3 公共后端（`server/`，代码完成，未部署）

ElysiaJS + MongoDB，账号体系：注册 → 6 位邮箱验证码 → 登录 → 令牌刷新 → 密码重置；
另有同账号设备发现 + 两条 WebSocket 密文中继。

```
server/src/index.ts          Elysia 装配、统一错误、优雅关闭、WS 限额配置
server/src/env.ts            启动时校验配置
server/src/db.ts             Mongo 连接 + 索引（含 TTL 与 devices）
server/src/auth/routes.ts    register/verify/resend/forgot/reset/login/refresh/logout/logout-all/me
server/src/auth/codes.ts     6 位码：生成、HMAC、定时安全比对（register/login/reset purpose）
server/src/auth/passwords.ts Argon2id（Bun 内置）
server/src/auth/tokens.ts    JWT access + 不透明 refresh，每次使用即轮换
server/src/mail/mailer.ts    SMTP 连接池 + 中文邮件模板
server/src/rate-limit.ts     滑动窗口（内存，仅单实例有效）
server/src/relay/hub.ts      Elysia-free relay 核心：认证、注册、绑定、纯密文转发、清理
server/src/relay/routes.ts   GET/DELETE /relay/devices + WS /relay/desktop、/relay/mobile
```

**已实测**：SMTP 凭据有效，465 和 587 都能认证，实际投递成功
（`250 Ok: queued as CAC1E343473`）。**但 `mail.nekofun.top` 是自签名证书**，目前必须
`SMTP_ALLOW_SELF_SIGNED=true` 才能连，建议签一张真证书。

**未实测**：auth 各路由没有真实 MongoDB 环境（只有 fake collection 的 Elysia 测试）。
relay 有**真实 Elysia WebSocket adapter 集成测试**（`src/relay/routes.test.ts`，真实
socket 收发 + 真实 HTTP），但同样用 fake collection——Mongo 真实联调仍然没有。

### 2.4 手机端账号 UI 与公网连接（代码完成，未与已部署后端真机联调）

`mobile/src/account-client.ts` + `mobile/src/AccountView.tsx`：登录/注册/verify/forgot/reset
完整流程。`mobile/src/PublicConnectionView.tsx` 已接入独立公网设备列表与连接，手机和桌面
登录同账号即可从 `/relay/devices` 选在线桌面。真机联调未做（后端未部署）。

### 2.5 独立公网 relay（代码完成）

详见 4.2 和 `server/README.md` 的「公网中继」章节。要点：桌面 `RelayService` 登录账号后
常连 `/relay/desktop`，safeStorage 存凭据和持久 P-256 私钥，自动 refresh/reconnect；手机
`relay-client` 走 `/relay/mobile`，与 `lan-client` 同接口，`desktop-client` facade 让
LAN/公网成为两个独立可选 transport。两端 P-256 ECDH → AES-256-GCM，AAD 绑定
connectionId/desktopId/peerId/direction，服务端只做形状校验并原样转发密文。

### 2.6 Computer Use（仅 Windows，可用）

`src/main/computer/`，底层是 `@trycua/cua-driver` 0.28.2 的进程内 SDK（Rust，N-API），
**不走 MCP**。设置 → 常规 →「Computer Use」开关（`AppPreferences.computerUse`，默认关），
对之后新开的任务生效；只读模式下工具不会出现（插件工具走同一条过滤）。

- `worker.ts` 在 Electron `utilityProcess` 里加载驱动：原生库崩了只死 worker；停止 = 杀进程，
  这是唯一确定能打断原生输入的方式。`host.ts` 管启动、超时（120s）、取消（1.5s 宽限后杀）。
- `tools.ts` 只暴露 11 个 `computer_*` 工具（上游约 60 个、schema ~150KB）。snapshot_id 由这一层
  按窗口记住，模型只传 `element_index`。截图作为 image content 回给模型。
- **打包坑**：驱动按路径加载 DLL，asar 里读不到。`electron-builder.yml` 把 `@trycua/**`、
  `@ubjs/**` 放进 asarUnpack，worker 手动把入口路径换成 `app.asar.unpacked` 再 import。
- **构建坑**：worker 是 main 的第二个入口，必须写在 `build.lib.entry` 里。改用
  `rollupOptions.input` 会让 electron-vite 退出 lib 模式，产物变成 ESM + 把依赖打进包。
- 驱动默认上报匿名遥测，worker 里设了 `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`。
- **AI 光标**（`cursor-overlay.ts`）：驱动自带的 overlay 在进程内模式下不工作，所以自己画。
  每个动作前光标滑到目标点，按压动效 + 标签（「点击 · Button 确定」），2.5s 无动作后隐藏。
  是一个跟着走的**小窗口**，放在目标点右下 2px，不是全屏遮罩：驱动像素点击前会做 UIA 命中
  测试、前台点击是真实 SendInput，全屏层会挡在目标点上。开了 content protection，模型的
  截图里看不到它。坐标：Electron 进程里驱动返回的元素 frame / 窗口 bounds 都是**物理像素**
  屏幕坐标（node.exe 里不是！DPI 感知不同），用 `screen.screenToDipPoint` 转。主窗口关闭时
  要 dispose 它，否则隐藏窗口会挡住 `window-all-closed`。
- **目标窗口置顶**（`window-raise.ts`，在 worker 里跑）：否则被操作的窗口压在 NekoCode 后面，
  用户只看到光标。每次动作前 `SetWindowPos` TOPMOST→NOTOPMOST + `SWP_NOACTIVATE`：抬到普通
  窗口最上层但**不激活**，键盘焦点留在原处（实测前台窗口不变）。最小化的先
  `ShowWindow(SW_SHOWNOACTIVATE)`。不用驱动的 `bring_to_front`，它会 SetForegroundWindow 抢焦点。
  Win32 通过 koffi 3.3.1 调用（预编译包 `@koromix/koffi-win32-*`，bun 会拦下它的 postinstall，
  不影响使用）；worker 里以 `nekocode.raise_window` 这个保留名处理，不转给驱动。只在有光标
  （即可视模式）时置顶；抬窗失败不影响动作本身。
- Windows 后台能力有限：右键/双击/打字/快捷键对部分应用（Chromium、Electron 等）会返回
  `background_unavailable`，工具描述里要求模型这时才用 `foreground: true` 重试。
- 已验证：单测 23 个；真实 Electron + 打包后的 asar 路径下 worker（含 koffi）能加载；点计算器
  1+2= 读回 3，计算器被抬到前台窗口之上、前台窗口（键盘焦点）全程不变，光标落点正确。**未验证**：让真实模型跑完整任务的效果；arm64；macOS/Linux（代码里直接不启用）。

---

## 3. 已经做过的决定 —— 不要推翻

这些是用户明确要求或权衡过的，**改动前必须问用户**：

| 决定 | 原因 |
|---|---|
| QQ 任务**不用 worktree**，直接改项目目录 | 发消息的人不在电脑前，隐藏分支上的改动他永远看不到；撤销靠 checkpoint（`/undo`） |
| 后端地址**硬编码**在 `mobile/src/account-client.ts`，不用 env | 用 GitHub Actions 发版，构建期变量漏配就发出一个指向空气的包 |
| 注册时**明确告知邮箱已注册**（`409 email_taken`） | 用户权衡后的选择。代价是允许账号枚举，已知悉 |
| 设置页的配置表单**放对话框**，页面只留状态 | 凭据填一次就不再看，摆在页面上会把实时状态挤到折叠线以下。参考 `ProvidersTab.tsx` |
| 授权用**配对码**，不用手填 ID 名单 | ID 难收集易打错，且不代表对方同意。兑换码这个动作本身就是同意。**这只适用于 LAN/QQ；公网是另一套（见下行）** |
| **LAN 和公网是完全独立、各自可选的连接模式** | 用户明确要求。公网不得依赖 LAN 配对/token/LAN 服务开启；切换只换 transport，两套 binding 各自保留 |
| **公网同账号自动发现，服务端分发公钥** | 用户在明确知悉「正常服务端只见密文，但主动恶意服务端可替换公钥做 MITM」后选择此方案。**不要擅自改成强制二维码配对** |
| **公网不 P2P，只中继 + E2E** | 数据是小体积 JSON，打洞省不了多少带宽却引入 NAT 穿透复杂度，且仍需中继兜底 |
| 后端**不知道自己的公网域名**，只绑 `127.0.0.1` | 域名只在 nginx 和客户端；绑回环让「必须走反代」成为结构约束而非文档里的一句话 |
| 未配对/未授权的 QQ 聊天**静默忽略**，但**本地日志要记** | 回一句「你没有权限」等于确认这里有东西；但本地面板是唯一能排查的地方 |

---

## 4. 剩下要做的（按优先级）

### P0 — 没有这些就不能上线

#### 4.1 密码重置流程（**已完成**）

```
POST /auth/forgot   { email }          → 发 6 位码（复用 verifications 集合，purpose: "reset"）
POST /auth/reset    { email, code, newPassword }  → 改密码 + revokeAllForUser()
```

服务端已接入：`VerificationDoc.purpose` 加了 `"reset"`，`sendCode` 按 purpose 分发出不同的
邮件，`/verify` 只接受 register/login，`/forgot` 对任何邮箱返回相同的 `{ ok }` 不泄露账号
存在性，`/reset` 原子认领验证码、清锁定、改密码并吊销全部 refresh session。

手机端已接入：`account-client` 新增 `forgot`/`reset`，`AccountView` 加了「忘记密码？」入口
和 forgot/reset 两个步骤。

新增 `server/src/auth/routes.test.ts`：用内存 fake collection 驱动真实 Elysia handler，覆盖
邮箱归一化、不泄露枚举、错误码计数、成功后踢 session、以及 reset/register 码互不通用。

#### 4.2 转发层 rendezvous + relay（**已完成**）

- **server**：`devices` 集合（`{userId, lastSeenAt}` 索引，无 TTL）；`GET /relay/devices`
  Bearer 列出自己设备（online 来自内存映射）；`DELETE /relay/devices/:id` 幂等注销并把在线
  socket 踢掉（desktop 4002 / mobile 4404）；`WS /relay/desktop`（hello 注册/替换旧会话）、
  `WS /relay/mobile`（hello 指定 desktopId，同账号校验，绑定 connectionId）。
- **加密**：P-256 ECDH → AES-256-GCM；device id = 公钥 SHA-256（服务端校验 id 与公钥一致）；
  AAD 绑定 connectionId + desktopId + peerId + direction；明文上限 1MiB；服务端只检查
  `{version,iv,data}` 形状并原样转发，不解 base64、不解析明文。
- **桌面**：`src/main/relay-service.ts` + `relay-credential-store.ts`——Electron safeStorage
  加密存账号 session 和持久私钥；登录/refresh/logout（先 DELETE 设备再登出）、指数退避
  重连、4401/4403/4404 语义、stale socket 隔离、peer 指纹异步校验；`LanService.handleRelay`
  在 LAN 服务**关闭**时也能用，relay 完全不依赖 LAN pairing/token/enabled。
- **手机**：`MobileRelayIdentityStore`（Preferences 持久身份）+ `relay-client.ts`（与
  `LanClient` 同接口、E2E 收发）+ `desktop-client.ts` facade（LAN/relay 双 binding、
  `desktop-transport` 偏好、切换/断开/自动 fallback）+ `PublicConnectionView` + `PairingView`
  公网 tab + `MobileApp` transport state。
- **测试**：`server/src/relay/routes.test.ts` 是真实 Elysia WS adapter + 真实 socket/fetch
  的集成测试（fake Mongo collection），暴露并修复了 adapter 不解析 JSON 文本帧的真实 bug。

**E2E 威胁边界（要写进隐私说明的话）**：服务端正常只转发密文，但它看得到
账号/设备 id/公钥/在线状态/连接时序/消息大小；**因为公钥由服务端分发，不抵抗主动恶意
服务端的公钥替换 MITM**。桌面私钥由 Electron safeStorage 保护；**手机私钥目前在
Capacitor Preferences（应用沙箱），不是硬件 Keychain/Keystore** —— 迁移到硬件存储是 P1，
不要声称已是硬件保护。

#### 4.3 后端部署

- relay 在线映射目前在**单进程内存**里，多实例不可用 —— 先单实例部署
- MongoDB **开认证**（现在 `.env.example` 里的 URI 没有用户名密码）
- nginx + Let's Encrypt（域名 `codeapi.nekofun.top`），TLS + WS upgrade 配置见 server/README
- 进程守护（systemd / pm2 / docker），开机自启
- `JWT_SECRET` 用 `openssl rand -base64 48` 生成，**换掉它会让所有人登出**
- **如果服务器在中国大陆，公网域名服务需要 ICP 备案** —— 这是硬性前置，先去查
- 数据库备份策略

#### 4.4 账号注销 / 数据删除

中国个人信息保护法要求提供。应用商店上架也会查。

### P1 — 上线后很快会需要

- **限流换成 Mongo/Redis**。现在 `server/src/rate-limit.ts` 是内存的，**多实例无效**。
- **relay 多实例**：在线映射是单进程内存，扩容需要 sticky session / Redis pubsub /
  共享 presence。当前按单实例设计。
- **手机 relay 私钥迁 Keychain/Keystore**（现在只是 Preferences 沙箱）。
- **隐私政策 + 用户协议**，应用商店必需。
- **服务端日志和告警**（现在只有 `console.error`）。
- **auth 路由真实 MongoDB 集成测试**（现在只有 fake collection；relay WS adapter 已有真实
  socket 测试但同样 fake collection），可以用 `mongodb-memory-server` 或 docker。
- **QQ 机器人真机验证**：流式回复、按钮交互、图片上传这三块的映射逻辑有测试，但从没连过
  真实 QQ。第一次接真机时盯着设置页的运行日志面板看。

### P2 — 可以慢慢来

- 多任务同屏（用户提过的后续计划，侧边栏点击仍需全屏打开）
- 代码图片的宽度/字号可能需要按真机观感调整（`src/main/qqbot/code-image.ts` 的 `WIDTH`）

---

## 5. 关键文件速查

```
src/main/index.ts                    主进程装配、全部 IPC、startBackgroundTask()
src/main/task-manager.ts             会话生命周期，onSettled/onSnapshot 两个监听
src/main/lan-service.ts              局域网 HTTP 服务 + handleRelay 内部分发
src/main/relay-service.ts            公网 relay 客户端（登录/重连/E2E 帧处理）
src/main/relay-credential-store.ts   safeStorage 加密的账号凭据 + 持久 relay 私钥
src/main/qqbot/service.ts            QQ 路由逻辑，所有聊天指令在 command()
src/main/qqbot/protocol.ts           QqConnection 接口，加新传输实现它即可
src/main/worktree-service.ts         后台任务的 git worktree（QQ 不用它）
src/shared/relay.ts                  relay 协议类型（identity/ciphertext/request/response/device/status）
src/shared/relay-crypto.ts           P-256 ECDH + AES-256-GCM + AAD + 身份校验（两端共用）
src/renderer/src/components/settings/ConnectSettings.tsx   设置→连接
src/renderer/src/components/settings/MobileSettings.tsx    LAN + 公网连接状态卡
src/renderer/src/components/settings/RelayLoginDialog.tsx  公网账号登录对话框
mobile/src/lan-client.ts             局域网客户端
mobile/src/account-client.ts         公网账号客户端（地址硬编码在这）
mobile/src/relay-identity.ts         手机持久 relay 身份（Preferences）
mobile/src/relay-client.ts           公网 E2E 客户端，接口与 lan-client 相同
mobile/src/desktop-client.ts         LAN/公网 transport facade（双 binding、切换）
mobile/src/PublicConnectionView.tsx  公网设备列表/连接 UI
server/README.md                     后端完整文档，含 nginx 配置和公网中继说明
```

`src/renderer/src/i18n/locales/en.ts` 是翻译 key 的 schema，`zh-CN.ts` 必须键完全一致，
少一个就是编译错误。

---

## 6. 需要用户提供 / 确认的

1. MongoDB 的部署位置和凭据
2. 服务器是否已备案、域名解析是否就绪
3. `mail.nekofun.top` 的证书是修还是继续用自签名
4. SMTP 密码曾在对话中明文出现过，**建议轮换**

---

## 7. 老实说

以下东西**写完了但从没在真实环境跑过**，第一次跑一定会有问题：

- relay **没有连过已部署的 server/Mongo**——桌面和手机没有在真实公网环境里互通过。
  WS adapter 有真实本地 socket 测试，但「本机 127.0.0.1 通」不等于「部署后通」
  （nginx/TLS/WS upgrade/防火墙都还没验证）。
- `server/` 的 auth 全部路由（没有真实 Mongo 环境）。
- 手机端账号/公网 relay 的真机联调（后端没部署，也没打过 APK 实机跑）。
- QQ 官方平台的流式回复、按钮、图片上传（没有可测的真机环境）。
- 代码图片在手机 QQ 上的实际观感。

它们的**纯逻辑和协议部分**有测试覆盖，但「测试过」不等于「跑通过」。别把这些当成已验证的。
