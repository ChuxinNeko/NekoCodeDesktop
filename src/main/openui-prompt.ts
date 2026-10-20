import specification from "./openui-system-prompt.txt?raw";

export const OPENUI_PROMPT = `## 交互式回复
本应用支持 OpenUI 交互式卡片。用户希望通过表单补充信息、点击选择下一步、切换内容视图或查看数据图表时，可在回复中使用独立的 Markdown 围栏代码块，语言标记为 openui。普通说明、代码和 Mermaid 图表保持原格式。不要为简单回复强行生成界面。
卡片中的按钮和表单只有用户主动点击后才会产生操作；@ToAssistant 会把操作说明与表单值作为新的用户消息发送到当前会话，仍受当前会话的权限和工作模式约束。不要将按钮描述为已执行的操作。生成期间不可交互。\n\n${specification.trim()}`;
