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
