# NekoCode Desktop

基于 [pi](https://github.com/earendil-works/pi) 内核的 Electron 桌面编码 Agent。

## 架构

```text
Renderer (React 19 + Tailwind v4)
   |  contextBridge，类型化 IPC（window.nekocode）
Preload
   |  ipcRenderer.invoke / 事件订阅
Main process (Electron)
   |-- AgentService       -> pi AgentSession / SessionManager / ModelRuntime
   |-- ModelConfigService -> safeStorage + model-profiles.json + 端点探测
   |-- TerminalService    -> node-pty
   `-- Git                -> 文件系统上的 git 操作
pi/                      -> pi agent 内核源码（本项目的一部分，可直接修改）
```

pi 的 `AgentSession` 在 Electron 主进程中运行，事件经 IPC 推送到渲染进程，由
`agent-projection` 投影成 UI 单元（user / assistant / tool / notice）。

## 环境要求

- Bun 1.4+
- Electron 运行所需的系统图形库（Linux 需要 GTK）

## 快速开始

```bash
bun install          # 安装应用依赖
bun run pi:build     # 构建 pi/（首次会拉取模型 catalog）
bun run dev          # electron-vite 开发模式
```

`bun run pi:build` 会调用 `scripts/pi-toolchain.ts`：它为 pi 的构建脚本提供 `node`（Electron
自带的 Node 运行时）与 `npm`（转发到 `bun run`）两个 shim，因此不需要系统级 node/npm。
Windows 上这两个 shim 是 `.cmd`（cmd.exe 不认 shebang，Bun Shell 也只按扩展名在 PATH 上找可执行文件）。
pi 的依赖（含 `tsgo`、`shx`、`esbuild` 等构建工具）都来自根目录这一次 `bun install`。

shim 依赖 `node_modules/electron/dist/` 里的 Electron 二进制。electron 包已经没有 postinstall，
`bun install` 只会装下载器，二进制要等第一次 `require("electron")` 时才懒加载；`pi:build` 只需要路径不会
require，所以 `scripts/pi-toolchain.ts` 在二进制缺失时会自己调一次 `node_modules/electron/install.js`。
若下载被墙导致它报 `Electron binary not found`，设置镜像后重跑安装脚本即可：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ bun node_modules/electron/install.js
```

`bunfig.toml` 把 bun 的 linker 固定为 `hoisted`：pi 的构建脚本与 `pi/scripts/` 里的打包器都从
仓库根解析裸导入，这假设 npm 那种扁平 hoisted 的 `node_modules`；bun 默认的按包链接会让这些
解析失败。

## 脚本

| 命令 | 作用 |
| --- | --- |
| `bun run dev` | 开发模式 |
| `bun run build` | 构建 main / preload / renderer 到 `out/` |
| `bun run start` | 预览已构建产物 |
| `bun run typecheck` | TypeScript 检查 |
| `bun run pi:build` | 构建 `pi/` 各包（改完 pi 源码后运行） |

## 使用

```bash
bun run build && ./node_modules/electron/dist/electron out/main/index.js /path/to/project
```

也可以在启动后从侧栏选择项目目录。命令行传入的目录优先于上次打开的项目。

| 面板 | 说明 |
| --- | --- |
| **会话** | 模型 / 思考级别 / 执行模式选择器，slash 命令（`/help`、`/new`、`/compact`、`/model`、`/thinking`、`/terminal`） |
| **Review** | unstaged / staged / branch 三种范围的 diff，stage / unstage / revert |
| **Pull requests** | GitHub PR 列表与详情（描述、检查、评论），可创建 PR、在系统浏览器打开 |
| **Automations** | 定时/周期运行提示词，支持 interval / daily / cron，带运行历史 |
| **Browser** | 内嵌浏览器（标签页、地址栏、前进后退），`target=_blank` 会开成新标签页 |
| **Terminal** | node-pty + xterm 的真实 PTY（底部抽屉） |
| **Settings** | Appearance（主题）、Models（自定义端点）、GitHub（token）、About |

Browser 是一个可拖拽调宽的右侧停靠面板；其余是侧栏里的整页视图。

## Pull requests 的凭据

PR 面板直接调用 GitHub REST API，**不依赖 `gh` CLI**（那才是额外安装）。凭据按以下顺序解析：

1. Settings → GitHub 里保存的 token（`safeStorage` 加密后写入 `github-auth.json`，0600）；
2. 本机已安装并登录的 `gh`，通过 `gh auth token` 自动复用；
3. 都没有时匿名访问——公开仓库可用，限流 60 次/小时。

仓库从项目的 git remote 解析，且只读 `git config` 里的原始 URL：`git remote -v` 会输出
`url.<base>.insteadOf` 重写后的地址，配了镜像的机器（常见于国内网络与企业代理）会因此被误判为非
GitHub 仓库。

限制：只支持 github.com。GitHub Enterprise 的地址形态与 GitLab/Gitea 无法区分，而且需要独立的
API base 与 token，因此不做半支持，面板会明确提示找不到 GitHub remote。

列表只发一次请求；diff 统计与检查状态只在详情里拉取，避免匿名限流被列表耗尽。

## Automations 的工作方式

调度器在主进程里跑一个 20 秒的 tick，每次问「现在有谁到期」，而不是给每个自动化挂一个定时器——
这样休眠/唤醒后错过的窗口会在下一个 tick 补上，改定义也不用重建定时器句柄。

- 定义写在 `automations.json`（原子重写），运行记录写在 `automation-runs/<id>.jsonl`（追加写）。
  一次运行开始时先落一条 `running`，结束时改写该条，因此被中断的运行仍然留下记录。
- 运行在独立的 PI `AgentSession` 里，使用与应用共享的 `ModelRuntime`（provider 注册是全局的，
  第二个 runtime 会重复注册）。它不会干扰窗口里的交互会话。
- 运行可用 Abort 停止：中止会转发到 PI 的 `session.abort()`。
- cron 支持标准 5 字段的 `*`、数值、范围、列表与 `*/n` 步长；不支持 `MON`/`JAN` 名字与
  `L`/`W`/`#` 扩展，解析失败会在编辑器里直接报错并给出下次运行时间预览。

## Review 与 git

Review 面板调用系统 `git`（与 Codex 的做法一致，不自带 git 二进制）。它区分两种情况：

- `git` 不在 PATH 上：面板显示安装提示，diff / stage / revert 全部禁用，不会抛出原始 IPC 错误；
- 目录不是仓库：面板提供 `git init`。

GitHub Enterprise 不支持；`url.<base>.insteadof` 镜像重写会被正确绕过（见上）。

## 浏览器预览与元素讨论

会话中成功写入或编辑独立 `.html` / `.htm` 文件后，右侧浏览器会自动打开预览；继续编辑同一页面会刷新原标签。预览通过仅监听本机的 HTTP 服务加载，支持项目内的相对样式、脚本和图片。Vue / Next.js / Vite 等项目需实际启动开发服务：运行时从启动命令或紧接着读取的 `.log` 日志识别本地 URL，确认服务可访问后打开，不会自行猜端口或启动项目。Fusion 辅助模型的编辑和启动输出同样有效。

点击浏览器地址栏右侧“选择元素并讨论”，再点击页面元素，将元素名称、定位选择器和页面地址追加到消息输入框。已有草稿保留，消息由用户发送；按 Esc、切换标签或离开浏览器可取消选择。

## 模型配置

输入框的模型菜单提供 **Fusion**。点击后在右侧配置 Lead 模型、Lead 思考等级、Sidekick 模型和 Sidekick 思考等级，再点击“使用 Fusion”。候选项来自当前可用模型，思考等级随模型能力变化。配置保存在会话中，也作为新会话的默认选择；选择普通模型即可退出 Fusion。

Fusion 中，Lead 负责规划、设计、调查和最终审查，Sidekick 承接实施与验证。建议选择能力强的 Lead 和成本较低的 Sidekick。简单任务由 Lead 直接处理，委派仅传递必要上下文；辅助任务顺序运行，避免重复调查和相互覆盖。Sidekick 需要运行构建或测试时，由 Lead 声明整个工作区作为任务范围以取得独占命令执行权限；只读和规划模式继续遵守原有权限。命令执行不是操作系统级沙箱。

pi 内置 provider 通过各自的凭据工作（`~/.nekocode/agent/auth.json` 或 provider 环境变量）。

自定义端点：Settings → Models → Add model，填写 API Base URL、协议（OpenAI Chat Completions /
OpenAI Responses / Anthropic Messages）、API Key 与模型 id。API Key 只在保存/拉取时以单次 IPC
进入主进程，由 `safeStorage` 加密后写入 `model-profiles.json`（0600）；列表与快照接口不返回密钥。

注意：`safeStorage` 在无系统密钥环的 Linux 上会退化为 `basic_text`，此时 `isEncryptionAvailable()`
为 false，设置页会显示警告且拒绝保存新配置。内置 provider 不受影响。

## 手机端与局域网并行任务

手机端是可安装的 **Android / iOS APP（Capacitor）**。直接复用桌面 React 的 `ChatView`、`Composer`、`Transcript`、模型菜单、工作流面板、图标和主题；仅为小屏增加工具栏换行、安全区域和导航。Electron 继续运行在电脑上，负责模型调用和项目操作。

1. 启动更新后的桌面端，进入 **Settings → 手机连接**，开启局域网访问。
2. 添加允许手机新建任务的项目目录。绑定手机可以查看全部会话，新建任务限于这些项目。
3. 安装 `dist/mobile/NekoCode-Android-debug.apk`（Android 8.0 及以上）。APP 默认显示「扫码配对」，点击「扫一扫，连接电脑」并允许相机权限，扫描电脑设置页的二维码即可自动填写地址并完成绑定。也可切换「手动配置」输入地址和配对码；电脑端的手动信息保留在折叠区。二维码与配对码均为 5 分钟有效、使用一次即失效，重新生成会立即作废旧码；可在桌面解除设备绑定。
4. 手机和电脑连接同一局域网。电脑有多个网卡时，可在二维码下方选择与手机同网段的地址。手机创建的任务会立即出现在电脑侧栏，执行时显示运行标记；两端可以各自查看不同会话，切换会话不会停止后台任务。手机也支持继续发送消息、停止任务、修改模型设置和回答工作流问题。

电脑需保持唤醒且桌面应用运行。局域网服务默认关闭，重启应用后需重新开启；关闭局域网访问不会停止已经接受的任务。默认端口为 `47832`，使用 HTTP，仅在可信网络中使用，不要映射到公网。Windows 防火墙需允许应用在专用网络通信，Wi-Fi 不能启用设备隔离。Android 使用原生 HTTP 连接电脑，不从电脑下载界面。

并行任务具有独立 AgentSession，共享一个 ModelRuntime；任务快照与桌面当前选择分离，未写入磁盘的新任务也参与列表合并。最多同时保留 31 个任务实例，完成且已落盘的非当前任务可按需释放、重新打开。**同一项目的并行任务共享文件，没有自动创建 Git worktree**，请避免多个任务同时修改相同文件或相互回退代码。任务退出后不自动恢复执行。请求去重覆盖一次桌面应用运行期间的网络重试。

二维码只包含版本标识、局域网地址、一次性配对码和有效期，不包含长期设备凭据。APP 使用后置相机本地解码（Android 使用 ZXing，iOS 使用原生扫描库），仅在点击扫码按钮时请求使用相机；拒绝相机权限后仍可手动配对。过期、无效或指向公网地址的二维码会被拒绝。

构建 APK 需要 JDK 21、Android SDK 36 与已接受的 SDK 许可：

```bash
bun install
bun run mobile:apk
```

`mobile:apk` 构建共享界面、同步 Android 工程、执行 Gradle 并把可安装的调试 APK 复制到 `dist/mobile/`。设置 `ANDROID_HOME` 指向 SDK；可用 `NEKOCODE_ANDROID_JAVA_HOME` 指定 Android Studio 自带的 JBR 21，或使用 `JAVA_HOME`。这份 APK 使用调试签名；正式签名和自动发布的配置见下方「GitHub 自动发布」。

```bash
bun run test:lan               # 并行生命周期、二维码校验、配对鉴权及请求去重
bun run test:lan:integration   # 隔离 Electron + 真实 PI + 本地模拟模型，不使用真实 API 凭据
bun run mobile:dev            # APP 界面的开发预览，非交付方式
```

开发预览仅在开发模式通过代理访问 `http://127.0.0.1:47834`，可用 `NEKOCODE_TEST_LAN_URL` 调整；`bun scripts/test-lan-integration.ts --preview` 可启动隔离测试后端。正式 APK 内置界面，使用 Capacitor 原生网络传输。Android 工程位于 `mobile/android`。

## GitHub 自动发布（桌面 + Android + iOS）

将 `package.json` 的 `version` 增加并推送到 `main` 后，`.github/workflows/release.yml` 会并行构建桌面安装包、Android APK 和未签名 iOS IPA，并上传到同一个 `v<version>` Release。Android 文件名为 `NekoCode-<version>-android.apk`，iOS 文件名为 `NekoCode-<version>-ios-unsigned.ipa`，均包含在 `SHA256SUMS.txt` 中；所有平台产物齐全后才发布。版本未变化的依赖调整不会发布。手动运行时，`publish=false` 只生成 Actions 构建产物（Android 为调试 APK）；`publish=true` 发布正式签名 Android APK 和供用户自签名的 iOS IPA。

**首次发布前**，在 GitHub 仓库 **Settings → Secrets and variables → Actions** 配置以下 Repository Secrets：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 正式签名 keystore 文件的 Base64 编码 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 签名密钥别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

已有 Android 发布密钥时必须沿用。首次创建可在本地执行下面的命令，交互输入密码，并将生成的文件离线备份；不要提交密钥或密码：

```bash
keytool -genkeypair -v -keystore nekocode-release.jks -alias nekocode -keyalg RSA -keysize 3072 -validity 10000
```

在 PowerShell 中可用 `[Convert]::ToBase64String([IO.File]::ReadAllBytes('nekocode-release.jks'))` 获取文件编码，保存到 `ANDROID_KEYSTORE_BASE64`；其余 Secrets 对应创建时输入的密码及别名。CI 仅将密钥临时还原到 runner 临时目录，构建后删除；缺少签名配置会明确失败，不会将调试签名 APK 作为正式 Release 发布。

APK `versionName` 直接读取根 `package.json`；CI 的 `versionCode` 为该工作流的 `github.run_number + 2`，同一次运行的重试保持不变，后续发布递增。保留现有工作流文件，迁移工作流或发布已有更高 versionCode 的应用时需相应提高编号偏移。正式签名与先前本地调试版签名不同，首次从调试版迁移需要卸载调试版再安装（手机本地配对设置会清除）；之后持续使用同一正式签名即可覆盖升级。

本地验证正式构建可设置 `ANDROID_KEYSTORE_PATH`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`、`ANDROID_VERSION_CODE`（大于 2 的递增整数）后执行 `bun scripts/build-android.ts --release`。

## iOS 构建与自行签名安装

已提交 iOS 原生工程 `mobile/ios/App/App.xcodeproj`，通过 Swift Package Manager 集成 Capacitor、相机扫码和偏好存储插件。iOS 15.0+ 的 iPhone / iPad 使用与 Android 相同的 React 界面和局域网接口；默认扫码配对，保留手动配置。首次使用需允许「相机」和「本地网络」权限，拒绝后可在 iOS 设置中重新开启。

**Windows 上获取 IPA：**

1. 将代码推送到 GitHub 的 main 分支。在 **Actions → Build and release → Run workflow** 选择 **main**，保持 **publish=false** 并运行。一次运行同时构建 Windows、macOS、Linux、Android 和 iOS，无需增加版本号；仅构建模式不需要签名 Secrets，Android 生成调试 APK，iOS 生成未签名 IPA。
2. macOS runner 使用 Xcode 构建真实设备的 arm64 Release 应用，关闭代码签名，生成标准 `Payload/App.app` 结构的 IPA。
3. 完成后下载 **installers-ios** Artifact，解压得到 `NekoCode-<version>-ios-unsigned.ipa`。构建失败时可下载 **ios-build-log** 查看日志。
4. 增加根 `package.json` 版本号并推送 main 时，同一个 **Build and release** 工作流构建全部平台，等待各平台成功后，把 IPA 与桌面安装包、Android APK 一起发布到同一个 Release。正式发布需要 Android 签名 Secrets；iOS 始终为供用户自行签名的 IPA，不需要 Apple 证书或 Team ID。

**用户自行签名：**

IPA 未签名，不能直接点击安装，也不是 App Store / TestFlight 包。Windows 用户可通过 [Sideloadly](https://sideloadly.io/) 或 [AltStore Classic](https://altstore.io/) 的官方安装流程，用自己的 Apple ID 签名后安装到连接的设备。按工具提示安装所需的 Apple 驱动、信任电脑和开发者；iOS 16+ 如有提示需开启开发者模式。免费 Apple ID 签名通常约 7 天有效，需要定期续签，具体限制以 Apple 和所用工具为准。Apple ID 与证书由用户在签名工具中管理，不上传至本项目或 GitHub Actions。

更新时沿用同一个 Apple ID、签名工具和 Bundle ID 设置，避免被识别成另一个应用。重新安装或改变签名标识可能需要重新绑定电脑。包内没有推送、App Groups 等付费账号专属 entitlement。

CI 不使用需要 provisioning profile 的 `xcodebuild -exportArchive`，而是归档、移除已有签名并打包 IPA。脚本会检查设备架构、版本号、隐私与界面资源，校验压缩包；所有产物齐全才发布。IPA 文件名保留完整 SemVer，Apple 包内版本只保留 major.minor.patch，构建号采用 GitHub 工作流运行编号。

在 macOS 上也可执行 `bun run mobile:ipa`；Windows 可执行 `bun run mobile:sync:ios` 生成界面并同步工程，但无法运行 Xcode。首次 CI 构建与真机扫码需要在 GitHub/macOS 和 iPhone 上验证。

## 修改 pi

pi 的源码在 `pi/`，与普通源码一样编辑；改完后：

```bash
bun run pi:build
bun run build
```

`pi/packages/*/dist` 是构建产物，已被 gitignore。

本次整合时对 pi 源码做了两处修正（都是上游因 hoisting 而隐藏的问题）：

- `pi/packages/ai` 补声明了 `@smithy/types`：`src/api/bedrock-converse-stream.ts` 直接 import
  它，但上游只在传递依赖里存在，靠 hoisting 才解析得到。
- 根 `package.json` 声明了 `esbuild`：`pi/scripts/build-coding-agent-bundle.mjs` 需要它，而
  上游只在 `packages/chord` 的依赖里。

## 安全说明

- pi 工具（read / bash / edit / write 等）以当前用户权限执行。执行模式（read-only / auto /
  full-access）只是限制暴露给模型的工具集，不是操作系统级沙箱。
- 不要在不受信目录或高权限账户下运行；生产环境建议使用容器或独立 sandbox。
- 自定义端点只接受 http(s) base URL（拒绝内嵌凭据、query/hash 与 `..` 编码绕过）。
- Browser 面板的 guest 页面：主进程强制 `contextIsolation` + `sandbox` + 关闭 `nodeIntegration`，
  只允许专用 partition，并**拒绝所有权限请求**（摄像头、麦克风、定位、通知、剪贴板读取）。
  需要这些能力的页面请用系统浏览器打开。地址栏只接受 http/https/about。

## 验证

```bash
bun run typecheck   # 类型检查
bun run build       # 构建
```

## 疑难

- 以 root 运行 Electron 需要 `--no-sandbox`；`bun run dev` 不接受该参数，因此 root/容器环境下请用：

  ```bash
  bun run build && ./node_modules/electron/dist/electron --no-sandbox out/main/index.js [项目目录]
  ```

- `pi:build` 首次运行需要联网获取模型 catalog（models.dev 等）。国内网络较慢时可先设置镜像：

  ```bash
  BUN_CONFIG_REGISTRY=https://registry.npmmirror.com bun install
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ bun run pi:build
  ```

## 致谢

- [earendil-works/pi](https://github.com/earendil-works/pi) — Agent 内核与工具集。

## PI 原生工作模式

输入框新增独立的工作模式选择：**Agent / Ask / Plan / Debug / Multitask**。原来的“只读 / 自动 / 完全访问”仍是执行权限，不与工作模式混用。

- Ask、Plan 由后端限制为只读，不靠提示词自律。
- 模式切换与需要澄清的问题通过真实确认卡片处理。
- Multitask 支持最多四个后台 PI worker、状态展示、取消、结果回传；写入 worker 有独立的路径范围，无 shell 或递归委派。
- Debug 使用每会话 NDJSON 日志及真实复现问答，不依赖不存在的 HTTP 服务或 XML 按钮。
- /commit-message 仅为暂存区生成建议提交信息；/compact 与自动压缩均应用本项目的摘要约束。
