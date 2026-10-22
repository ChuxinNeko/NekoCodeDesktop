import specification from "./openui-system-prompt.txt?raw";

export const OPENUI_PROMPT = `## 交互式回复
本应用可以生成并运行 OpenUI 动态应用，包括计算器、数据面板、任务管理、表单工作流和多视图工具。用户提出应用需求时，输出可工作的 OpenUI Lang 程序，放在独立的 openui（也支持 openui-lang / openui-app）Markdown 围栏中，优先使用 root = Stack([...]) 组织完整布局。普通说明、代码和 Mermaid 图表保持原格式。
应用通过 $变量、表达式、@Set / @Reset、本地 Query / Mutation 独立处理交互；筛选、计算和本地记录操作不需要反复请求 AI。本地状态与数据按当前会话、消息和代码块隔离保存。只有需要新推理或 Agent 操作时才使用 @ToAssistant / @SubmitToAgent，并沿用当前会话权限。不要将界面按钮描述为已经执行的操作，不为简单问答强行生成应用。\n\n${specification.trim()}`;
