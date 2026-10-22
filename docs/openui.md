# OpenUI 动态应用

NekoCode 使用 `@openuidev/react-lang` 1.0.1 与 `@openuidev/react-ui` 0.18.1，
在聊天中生成并运行 OpenUI Lang 应用。接入完整的官方应用组件库，同时兼容原来的聊天卡片。
模型、Agent 工具、权限、会话保存与 IPC 沿用原有实现。

## 使用

重新构建并启动应用，在内置 PI 会话中发送：

- 「做一个任务管理器，可以新增、按名称筛选、删除任务，并在本机保存数据。」
- 「做一个计算工具，输入变化后立即更新结果，不要每次调用 AI。」
- 「根据项目里已经存在的 data/metrics.json 生成仪表盘，可以切换表格与图表。」
- 「做一个有首页、设置页和编辑弹窗的小应用。」

AI 输出完整的 `openui` 围栏程序，也支持官方 `openui-lang` 和 `openui-app` 标记。
用户自己发送的代码示例仍显示源码。程序默认以 `root = Stack([...])` 组织自由布局；
原来的 `root = Card([...])` 与 `Card(children, sources)` 继续兼容。

应用提供「展开应用 / 返回对话」与源码切换。展开时保留当前变量、输入和本地数据。
生成期间暂停交互；生成完成后，本地操作独立运行。Agent 忙碌时，本地计算与筛选仍可使用，
发消息、文件导航等宿主动作继续遵守原会话的可用性检查。

## 布局、状态与组件

使用完整的官方应用库：Stack、Card、Tabs、Accordion、Carousel、Modal、内容与列表、
指标卡片、所有内置图表、表格与可编辑表格，以及日期、滑块、选择框、复选框等表单组件。
同时保留 FollowUpBlock 等聊天专用组件。Select 使用原生选择框以避免页面滚动锁定；
Modal 使用应用现有的对话框基础组件，支持在展开的应用中继续打开编辑弹窗。

- `$变量` 与输入字段双向绑定；`@Set`、`@Reset` 更新状态。
- 表达式与条件渲染处理本地计算、页面切换、显示和隐藏。
- `@Filter`、`@Sort`、`@Sum`、`@Count`、`@Each` 等内置函数处理筛选、排序与汇总。
- `Action([...])` 串行执行本地动作，例如保存、刷新列表、清空输入。
- 输入过滤器可放在 Form 外的 FormControl 中；需要校验的提交使用 Form 与显式按钮。

这些操作由 Renderer 执行，不需要再次调用模型。

## 数据工具

生成器与运行时共用以下工具定义。Query 自动读取数据；Mutation 只在用户点击含 `@Run`
的按钮时执行。工具名使用字符串字面量，不允许借用 Query 自动写入本地记录。

| 工具 | 参数 | 返回 | 用途 |
| --- | --- | --- | --- |
| `app_list` | `{collection}` | `{rows, total}` | 读取本应用的本地集合 |
| `app_save` | `{collection, record}` | `{row}` | 新增记录；保留 `record.id` 时更新 |
| `app_delete` | `{collection, id}` | `{deleted}` | 删除一条本地记录 |
| `project_read_json` | `{path}` | `{data}` | 通过已有项目文件读取接口加载完整 JSON |

集合初始为空。新增记录不传 id，运行时生成稳定 ID。新增、修改或删除后，使用 `@Run(listQuery)`
刷新相应查询。项目文件路径必须来自实际对话或工具结果；沿用项目作用域校验，拒绝越界路径、
二进制文件、截断文件和无效 JSON。会话切换后，不会接收旧项目的异步读取结果。

示例：

```text
items = Query("app_list", {collection: "tasks"}, {rows: [], total: 0})
create = Mutation("app_save", {collection: "tasks", record: {title: $title}})
submit = Button("添加", Action([@Run(create), @Run(items), @Reset($title)]))
```

完整可执行示例在 `src/renderer/src/lib/openuiExamples.ts`，同时用于生成模型指令与测试。

## 持久化与范围

内置主会话中的每个应用，使用会话 ID、消息 ID 和代码块位置隔离本地记录、表单字段与 `$变量`。
刷新、重开会话或切换展开视图后可恢复。另一个消息或代码块不会读到这些记录。数据保存在当前
设备的界面存储中，不会自动同步到服务器、其他设备或项目文件；清除应用数据也会清除此存储。
没有稳定会话/消息标识的辅助视图只在内存中运行。

每个应用的存储上限为 1,000,000 字节，每个集合最多 2,000 条记录。写入失败会报错，
不会将未保存的记录操作报告为成功。组件或数据源局部出错时保留可用内容；数据查询支持重试，
整个程序无法解析时提供源码回退。

## 与当前 Agent 协作

| 动作 | 行为 |
| --- | --- |
| `@ToAssistant(message)` | 向当前会话发送新的用户消息，带上表单字段 |
| `@SubmitToAgent(message, context?)` | 发送自然语言请求、结构化上下文与字段值 |
| `@OpenFile(path, line?)` | 打开已确认的项目相对文件，可定位到行号 |
| `@OpenTask(taskId)` | 查看当前会话中的已有任务 |
| `@OpenUrl(url)` | 通过原有链接入口打开 HTTP/HTTPS 地址 |

本地交互优先使用 `$变量` 与数据工具；需要新推理或真正的项目操作时才使用 Agent 动作。
提交消息的气泡保持自然语言显示，完整上下文仍在模型历史中。宿主动作受现有权限、项目作用域、
忙碌状态和视图能力约束。界面不会获得任意 IPC、Shell、文件写入或网络请求权限。

## 维护与验证

- `openuiLibrary.ts`：完整应用组件库、旧卡片兼容与模型指令选项。
- `openuiComponents.tsx`：Card 兼容适配与 Modal；`openuiNativeSelect.tsx`：原生选择框。
- `openuiToolDefinitions.ts`：模型和运行时共用的工具 schema。
- `openuiRuntime.ts`：隔离存储、本地 CRUD 与工具派发。
- `openuiProgram.ts`：Query / Mutation 写入约束。
- `OpenUIBlock.tsx`：代码块身份、展开、源码与运行实例。
- `OpenUIRenderer.tsx`：响应式渲染、数据工具、状态恢复及错误处理。
- `src/main/openui-system-prompt.txt`：生成的静态说明；Electron 主进程不导入 React 组件。

修改组件库、工具定义、示例或升级依赖后：

```bash
bun run openui:prompt
bun run openui:prompt --check
bun test test/renderer/lib/openui.test.tsx test/renderer/lib/openuiRuntime.test.ts test/renderer/lib/openuiNativeSelect.test.tsx test/renderer/components/chat/Markdown.test.tsx test/main/prompt-library.test.ts
bun run typecheck
bun run build
bun run mobile:build
```

首次克隆先执行 README 中的 `bun install` 与 `bun run pi:build`。
不需要 OpenUI Gateway、Autofix 或额外 API Key；遥测上报关闭。
完整组件和工具说明增加模型系统提示词长度，继续按原提供商计量。

当前输出为完整的 OpenUI Lang 应用，不执行任意 JavaScript/HTML，不自动接入所有 MCP/第三方后端，
也不将后续消息的片段自动合并为旧程序。外部 ACP 智能体不会自动注入这些生成指令；
Flutter 手机端尚无 OpenUI 渲染器。React 手机端共享渲染能力，本地数据按设备保存。

### 前端应用完成后的预览卡片

桌面聊天会根据每轮检查点记录的实际前端文件改动，在该轮最终回复正文之后自动添加「前端预览」卡片，无需模型手写 OpenUI 代码。普通问答、只有后端改动的轮次，以及尚未完成的回复不会添加卡片。

卡片支持直接操作页面、切换手机宽度、刷新、收起，以及在浏览器面板中打开。建议按钮包含优化界面、适配手机、检查交互；点击后才向 AI 发出新请求，并携带原始轮次和文件列表作为上下文。会话忙碌时暂停提交。

预览使用已有浏览器隔离与权限策略。开发服务地址仅从成功执行的服务启动日志中提取，并重新检查可访问性；独立 HTML 使用工作区内的静态预览服务器。React/Vue 等框架入口需要开发服务，服务未运行时提供「启动预览」按钮。不会执行回复正文中随意出现的地址或猜测端口。

历史卡片展示的是**当前工作区的实时应用**，不是旧版本快照。重开会话后会重新解析地址；服务已停止时可重新启动。手机与 WebUI 保留建议按钮，本地交互预览需在桌面应用中打开。
