# NekoCode / PI 原生工作模式提示词

这套资产已接入 **当前 NekoCode Desktop 仓库**。它不再使用 Cursor/opencode 的工具名、XML 输出协议或 IDE 隐式上下文。

## 用户入口

输入框工具栏的“工作模式”菜单提供 Agent、Ask、Plan、Debug、Multitask；旁边原有的菜单是独立的“执行权限”。也可输入：

- /mode agent、/mode ask、/mode plan、/mode debug、/mode multitask
- /commit-message [附加要求]：根据真实暂存区生成建议提交信息，不暂存、不提交、不发布。
- /compact [保留重点]：使用本目录的压缩指令进行手动压缩；自动压缩也使用同一套指令。

工作模式记录在 PI 会话的 nekocode.workflow.v1 自定义条目中；重开会话恢复模式与 Todo。上次选择同时保存到桌面偏好中，供新会话使用。旧会话没有记录时使用当前默认模式。

## 模式与实际能力

| 模式/角色 | 行为 | 接入方式 |
| --- | --- | --- |
| Agent | 实现、修改、验证 | 原生文件/shell 工具，question、todo_write、switch_mode、commit_message |
| Ask | 只读调查与问答 | read、grep、find、ls；可提问、请求确认切换模式 |
| Plan | 只读研究并输出 Markdown 计划 | Ask 的能力，加 Todo；没有文件写入或 shell 权限 |
| Debug | 根据复现与日志调查、修复、验证 | Agent 的编辑/运行能力，加 debug_log；用 question 等待复现反馈 |
| Multitask | 协调独立后台 PI 会话 | task、task_status、task_cancel；完成/失败后将结果送回父会话并续跑 |
| Subagent | 只读调查子会话 | task(kind="explore") 使用，仅四个只读工具 |
| Commit | 隔离的提交信息生成器 | 内部 helper，无工具，只接受暂存 diff/近期提交标题等输入 |
| Compaction | PI 上下文摘要的补充指令 | SDK compactionInstructions，覆盖手动、自动及 split-turn 摘要 |

### 权限规则

- Ask、Plan 和 Subagent 无论执行权限菜单选什么，都不能修改项目或执行命令。
- 选择“只读”会进一步收紧其他工作模式，包括阻止写入型 worker。
- 模型调用 switch_mode 必须通过真实界面确认，不能提升执行权限；普通回复中的“批准”“切换模式”不具有控制效果。
- 后端每次执行工具前再次检查权限，不能只靠提示词约束，也不能通过重设工具列表绕过。
- auto / full-access 保留桌面端原有语义：都可使用完整原生工具集，并不代表操作系统沙箱或逐次 shell 审批。
- 运行期间切换工作模式/执行权限需先停止；模型通过 switch_mode 获得确认的切换可在当前工具轮次中生效。

### 后台任务

最多四个活动 worker。探索任务只读；写入任务必须声明工作区内的 writablePaths，运行时拒绝越界、经符号链接逃逸及重叠写入范围。

写入 worker 仅提供 read/grep/find/ls/edit/write，不提供 shell 或嵌套任务。父会话负责构建、测试和最终集成；有写入 worker 运行时，父会话不能写入其范围或执行 shell。完成消息是给父会话的数据，不是新的用户授权。

停止、关闭或切换会话会取消其任务。重新打开会话后，之前仍标记 running 的任务转为 cancelled，不自动重放副作用。界面保存并展示最近的任务状态/结果。

### Debug 日志

调用 debug_log(action="status") 获得实际日志路径。日志存于 Electron userData/debug-logs 下，按会话生成唯一 NDJSON 文件名。read 读取有上限的尾部内容；clear 只清空本会话文件。

没有内置 HTTP 日志接收服务。后端程序可直接追加 NDJSON；浏览器/远端环境使用可用的控制台、测试输出或用户提供的日志。复现反馈使用 question 卡片，没有 reproduction_steps、Proceed 或 Mark as fixed 私有标签。

## 资产与加载

- common_prefix.md：角色、沟通、Git 安全、真实输出协议、运行时权限说明。
- 各模式 prompt.md：职责与工作流程。
- 各模式 tools.json：version=1 的原生工具名清单；由运行时实际消费，而不是旧的 OpenAI function 描述。
- Plan / Debug 提醒文件：与对应模式一起进入系统提示词，无需模型输出特殊标签。
- Commit 独立使用专用提示词；Compaction 作为 PI 摘要附加指令使用，保留 PI 普通摘要与分段摘要各自的标题结构。

加载入口：src/main/prompt-library.ts，通过 Vite 的 raw import 将资产嵌入主进程产物，不依赖打包后的源码目录。仅 MODEL_ID / RUNTIME_POLICY 是模板变量，由实际会话状态替换；Todo/任务的有界状态也会附在系统提示词中。

PI 的 AGENTS.md、Skills、APPEND_SYSTEM.md 仍由资源加载器处理。桌面端会将用户 SYSTEM.md 作为模式规则后的自定义补充，而不是让它替换权限边界。隔离 helper 不加载扩展；Commit 不继承项目提示词。

## 代码与输出格式

标准 Markdown 围栏代码块可以正常显示。文件路径目前作为行内代码显示，不承诺自动跳转；Mermaid/LaTeX 没有新增图形渲染支持。代码块不会被当成工具调用执行。

不存在自动附加的光标、终端快照目录、linter、MCP 描述目录或图像生成能力。需要这些能力时先实现并注册真实工具，再更新清单及对应提示词。公共前缀不再将普通任务默认视作获授权 CTF。

## 验证与构建

- bun run test:workflow：提示词契约、权限矩阵、提问/确认、任务范围/取消/续跑、持久化、日志、提交信息、手动及自动压缩、界面服务端渲染。
- bun test src/main/ src/shared/：桌面端完整测试。
- bun run typecheck
- 修改 PI 核心后先执行 bun run pi:build，再执行 bun run build。

工作流集成测试使用本地回环模拟模型，不调用真实模型或使用用户 API 凭据。运行时本身仍使用用户选择的 PI 模型配置。
