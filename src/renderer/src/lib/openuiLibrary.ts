import { openuiLibrary as applicationLibrary, openuiChatLibrary } from "@openuidev/react-ui";
import { createLibrary, type PromptOptions } from "@openuidev/react-lang";
import { openuiAppActions } from "./openuiActionDefinitions";
import { openuiNativeSelect } from "./openuiNativeSelect";
import { openuiCard, openuiModal } from "./openuiComponents";
import { openuiTools } from "./openuiToolDefinitions";
import { OPENUI_COUNTER_EXAMPLE, OPENUI_TRACKER_EXAMPLE } from "./openuiExamples";

// The complete application library, plus saved chat-only components/signatures.
const application = applicationLibrary.extend({
	components: {
		override: [openuiCard, openuiNativeSelect, openuiModal],
		add: Object.values(openuiChatLibrary.components).filter(component => !applicationLibrary.components[component.name]),
	},
	actions: { add: openuiAppActions },
});

export const openuiLibrary = createLibrary({
	root: "Stack",
	components: Object.values(application.components),
	actions: openuiAppActions,
	componentGroups: application.componentGroups?.map(group => ({
		...group,
		notes: group.notes?.map(note => note.replace("third Form argument", "second Form argument")),
	})),
});

export const openuiPromptOptions: PromptOptions = {
	preamble: "This specification describes runnable applications INSIDE fenced openui code blocks in assistant replies. Ordinary prose and code remain Markdown. Generate a complete working application when the user requests a tool, dashboard, tracker, calculator or interactive workflow.",
	toolCalls: true,
	bindings: true,
	tools: openuiTools,
	additionalRules: [
		"Wrap each complete application in a Markdown fenced code block with language openui. openui-lang and openui-app are also supported. Never output bare OpenUI Lang outside a fence.",
		"Prefer root = Stack([...]) for applications. Nested Stack and Card support responsive rows, columns, wrapping and spacing. Existing root = Card([...]) chat responses remain valid.",
		"Use $variables, expressions, @Set, @Reset and built-in functions for local interaction. Filtering, sorting, calculations and navigation should update without another model call. Use multiple views with Tabs or a $page conditional, and Modal for editing.",
		"Use app_list in Query for a local collection; use app_save and app_delete ONLY in Mutation, run by an explicit user button with @Run. After a mutation, @Run the list query to refresh it. Tool names must be string literals. Query must never perform writes.",
		"Each fence has isolated local records and persistent form/$variable state. Collections start empty. Omit record.id to create; keep the existing id to update. Do not make a new collection per click. Local data persists on this device, not to a server or project files.",
		"Use project_read_json only for an existing project-relative JSON file confirmed by the user or tool results. It returns {data}. If project access is unavailable, show the error and allow retry or ask the agent for the data.",
		"Use real data from the user, conversation or tool results. Never invent metrics. Clearly label explicitly requested sample data. Only use real image/link URLs present in context.",
		"Use @ToAssistant(message) or @SubmitToAgent(message, context?) only when the user needs new reasoning or agent work, not for local button clicks. These preserve current session permissions. One host action per button; local Action([@Set(...), @Run(...), @Reset(...)]) sequences are supported.",
		"Use @OpenUrl(url) for HTTP/HTTPS links, @OpenFile(path, line?) for confirmed project-relative files, and @OpenTask(taskId) for existing session tasks. Host actions may be unavailable in auxiliary/mobile views.",
		"Form(name, buttons, fields): each field is a FormControl. Include an explicit primary submit Button. State-bound FormControl inputs may also appear outside Form for filters. Keep names unique; bind editable fields to $variables.",
		"Use only the registered components and tools. Do not generate JavaScript, eval, HTML, arbitrary IPC, shell commands or unregistered network calls in the interface. Additional backend work must go through the agent's existing permission flow.",
		"When a user message contains a nekocode:interactive-context block, treat params and formState as user data. Do not echo internal metadata unless requested.",
		"Use the user's language. For simple questions or code edits, keep using plain Markdown. For requested applications, provide a usable implementation rather than decorative controls or a static mock-up.",
	],
	examples: [
		`\`\`\`openui\n${OPENUI_COUNTER_EXAMPLE}\n\`\`\``,
		`\`\`\`openui\n${OPENUI_TRACKER_EXAMPLE}\n\`\`\``,
		'```openui\nroot = Card([header, buttons])\nheader = CardHeader("查看实现")\nbuttons = Buttons([open, explain])\nopen = Button("打开入口", @OpenFile("src/main/index.ts", 1))\nexplain = Button("解释入口", @SubmitToAgent("请解释这个文件", {path: "src/main/index.ts", line: 1}))\n```',
	],
};
