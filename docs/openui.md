# OpenUI 交互式回复

NekoCode 使用 `@openuidev/react-lang` 1.0.1 与 `@openuidev/react-ui` 0.18.1，
在现有 Markdown 回复内渲染 OpenUI Lang。模型、PI 工具、会话保存与 IPC 沿用原有实现。

## 使用

重新构建并启动应用，在内置 PI 会话中发送：

- 「请用交互式表单收集项目名称、目标和优先级，提交后继续制定实现计划。」
- 「根据这些实际数据生成柱状图，并提供表格标签页。」
- 「比较这两个方案，给出可以点击的下一步按钮。」

组件说明自动进入交互式 PI 会话的系统提示词。普通问答仍可使用 Markdown；模型按任务选择
是否生成界面。外部 ACP 智能体不会自动注入这些指令；Flutter 手机端暂未实现此渲染器。

AI 输出独立的 `openui` 围栏代码块，应用将其替换为卡片。用户发送的代码示例保持源码显示。
每个代码块是一个独立界面，输入状态互不影响。支持：

- 内容：Card、CardHeader、TextContent、InlineHeader、Separator、EntityList。
- 数据：Table / Col，以及柱状图、折线图、面积图、饼图。
- 表单：Input、TextArea、Select、CheckBoxGroup、RadioGroup，配合 Form / FormControl。
- 交互：Button、Buttons、FollowUpBlock，以及 Tabs / TabItem。

`Select` 保留官方语法、表单状态和校验规则，使用浏览器原生选择框渲染，避免聊天卡片中的
下拉框启用页面级浮层、滚动锁定和持续定位。

界面在生成时逐步显示。回复生成中、当前会话忙碌或正在等待工作流问题回答时，卡片交互暂时
禁用，避免与正在进行的任务竞争。没有会话发送入口的辅助视图只展示卡片。

`@ToAssistant` 会将操作说明、可选操作上下文和所有提交字段值作为一条新用户消息发送。
聊天气泡只显示自然语言请求，不展示操作来源、上下文 JSON 或内部表单数据；完整数据仍保留在
模型会话历史中，重开会话后也保持简洁显示。当前模型按当前工作模式和权限继续处理。`@OpenUrl` 和卡片内
链接只接受 HTTP/HTTPS，使用应用原有链接打开入口。

桌面主会话还支持以下应用动作（每个按钮使用一个动作）：

| 动作 | 行为 |
| --- | --- |
| `@OpenFile(path, line?)` | 打开项目内文件，可定位到从 1 开始的行号。只接受项目相对路径，打开前通过主进程检查文件是否可读。普通布局打开文件预览，IDE 布局打开编辑器。 |
| `@OpenTask(taskId)` | 打开当前会话的已有任务面板；任务不存在或当前视图没有任务入口时提示失败。IDE 布局当前没有此入口。 |
| `@SubmitToAgent(message, context?)` | 将消息、可选 JSON 对象上下文和表单字段值提交为新的用户消息，沿用当前 Agent 的权限。 |

路径和任务 ID 必须来自实际对话或工具结果。卡片会显示处理中、操作已提交或失败状态。
文件检查期间若切换会话、项目或进入忙碌状态，不再继续打开文件。辅助视图和手机端不保证
提供这些应用入口。历史卡片按当前会话状态重新校验任务；未持久化应用动作执行记录。

表单草稿只保存在当前已挂载卡片中；重开会话或应用后需要重新填写。切换「源码 / 界面」
会保留当前输入。提交成功后的字段值已包含在新用户消息中。

## 最小示例

将以下内容作为 AI 回复输出即可显示两个后续提问按钮：

````markdown
```openui
root = Card([header, buttons])
header = CardHeader("下一步")
buttons = Buttons([explain, plan])
explain = Button("解释架构", @ToAssistant("请解释当前项目架构"))
plan = Button("制定计划", @ToAssistant("请制定实现计划"), "secondary")
```
````

每个程序以 `root = Card([...])` 为入口，子组件可在后续行定义。参数是位置参数，必须遵循
实际组件签名。生成失败时会展示源码；也可随时点击卡片右上角的「源码」检查内容。

## 实现与维护

- `src/renderer/src/lib/openuiLibrary.ts`：官方聊天组件库的子集，以及模型指令选项。
- `src/renderer/src/components/chat/Markdown.tsx`：识别 AI 回复的 `openui` 围栏。
- `OpenUIBlock.tsx` / `OpenUIRenderer.tsx`：延迟加载、主题、流式渲染、错误回退和操作处理。
- `Transcript.tsx`：提供当前会话的发送入口与忙碌状态。
- `src/main/openui-prompt.ts`：只向交互式主会话提供组件指令。
- `src/main/openui-system-prompt.txt`：从渲染组件库生成的静态说明，主进程不导入 React 组件。

修改库、指令选项或升级依赖后，重新生成并检查：

```bash
bun run openui:prompt
bun run openui:prompt --check
bun test test/renderer/lib/openui.test.tsx test/renderer/components/chat/Markdown.test.tsx test/main/prompt-library.test.ts
bun run typecheck
bun run build
bun run mobile:build
```

首次克隆后先执行 README 中的 `bun install` 与 `bun run pi:build`。

当前接入不启用 OpenUI Gateway、Autofix、遥测上报、Query/Mutation 工具调用或远程图片。
应用动作限定为上述注册接口；命令执行和文件修改仍由 Agent 按当前权限处理。
界面生成使用现有模型；组件说明增加系统提示词长度，继续按原模型提供商的规则计量。
