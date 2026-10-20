import { openuiChatLibrary } from "@openuidev/react-ui";
import { createLibrary, type PromptOptions } from "@openuidev/react-lang";
import { openuiAppActions } from "./openuiActionDefinitions";
import { openuiNativeSelect } from "./openuiNativeSelect";

// The prompt and renderer use the same subset of the official chat library.
// No images or remote queries are exposed.
const components = new Set([
	"Card", "CardHeader", "TextContent", "InlineHeader", "Separator",
	"Table", "Col", "BarChart", "LineChart", "AreaChart", "Series", "PieChart", "Slice",
	"Form", "FormControl", "Label", "Input", "TextArea", "Select", "SelectItem",
	"CheckBoxGroup", "CheckBoxItem", "RadioGroup", "RadioItem",
	"Button", "Buttons", "FollowUpBlock", "FollowUpItem", "Tabs", "TabItem", "EntityList",
]);

const subset = openuiChatLibrary.extend({
	components: { remove: Object.keys(openuiChatLibrary.components).filter(name => !components.has(name)) },
});

export const openuiLibrary = createLibrary({
	root: subset.root,
	components: Object.values(subset.components).map(component => component.name === "Select" ? openuiNativeSelect : component),
	actions: openuiAppActions,
	// The upstream notes mention components excluded from this integration.
	componentGroups: subset.componentGroups?.map(({ name, components }) => ({ name, components })),
});

export const openuiPromptOptions: PromptOptions = {
	preamble: "The following specification applies only INSIDE fenced openui code blocks in assistant replies. Ordinary prose and code remain Markdown. Generate an interactive interface only when useful or requested.",
	toolCalls: false,
	bindings: false,
	additionalRules: [
		"Wrap every interface in a Markdown fenced code block with language openui. Never output bare OpenUI Lang outside that fence.",
		"Every interface starts with root = Card([...]). Define child references on separate lines for progressive streaming.",
		"Only use the components listed below. Do not use Stack, Query, Mutation, external images, scripts or HTML.",
		"Use real data from the user, conversation or tool results. Never invent metrics. Label explicitly requested example data as examples.",
		"Use @ToAssistant(message) for follow-up buttons and form submits. This sends a user message to the current agent; it does not itself execute an application operation.",
		"Use @OpenUrl(url) only for real http/https URLs present in the conversation or tool results.",
		"Use @OpenFile(path, line?) to open an existing project-relative file at an optional 1-based line, and @OpenTask(taskId) to show an existing task in the current session. Only use paths and IDs from the conversation or tool results; never invent them. These actions may be unavailable in auxiliary or mobile views.",
		"Use @SubmitToAgent(message, context?) for a follow-up with a JSON object of structured context. Form fields accompany the user message automatically. This requests agent work under existing permissions; it does not directly execute commands, edit files or raise permissions. Use one action per button.",
		"When a user message contains a nekocode:interactive-context block, use its params and formState as supporting user data and respond naturally to the user's request. Do not echo the metadata, JSON, action provenance or form plumbing unless the user asks to inspect it.",
		"Form requires Form(name, buttons, fields). Put each field inside its own FormControl. Include exactly one primary submit Button; field names must be unique. Form values will accompany the submitted message.",
		"Table is column-oriented: Table([col1, col2]); each Col(label, data) holds an equally sized array of strings or numbers.",
		"Keep the UI small and use the user's language. Plain questions and code edits generally need only Markdown; do not add decorative forms or fake actions.",
	],
	examples: [
		'```openui\nroot = Card([header, buttons])\nheader = CardHeader("查看实现")\nbuttons = Buttons([open, explain])\nopen = Button("打开入口", @OpenFile("src/main/index.ts", 1))\nexplain = Button("解释入口", @SubmitToAgent("请解释这个文件", {path: "src/main/index.ts", line: 1}))\n```',
		'```openui\nroot = Card([header, choices])\nheader = CardHeader("选择下一步")\nchoices = Buttons([explain, compare])\nexplain = Button("解释架构", @ToAssistant("请解释当前项目架构"))\ncompare = Button("比较方案", @ToAssistant("请比较可行的实现方案"), "secondary")\n```',
		'```openui\nroot = Card([header, form])\nheader = CardHeader("补充需求")\nform = Form("requirements", buttons, [field])\nbuttons = Buttons([submit])\nsubmit = Button("提交需求", @ToAssistant("请根据这些需求继续"))\nfield = FormControl("目标", Input("goal", "输入希望实现的目标"))\n```',
	],
};
