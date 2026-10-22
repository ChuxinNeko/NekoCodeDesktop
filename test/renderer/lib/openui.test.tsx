import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createParser } from "@openuidev/react-lang";
import { evaluate, parseExpression, tokenize } from "@openuidev/lang-core";
import type { ActionEvent } from "@openuidev/react-lang";
import { openuiLibrary, openuiPromptOptions } from "../../../src/renderer/src/lib/openuiLibrary";
import { createOpenUIHostActions, dispatchOpenUIAction, openuiActionRequest, openuiWebUrl, type OpenUIHostScope } from "../../../src/renderer/src/lib/openuiActions";
import { en } from "../../../src/renderer/src/i18n/locales/en";
import { zhCN } from "../../../src/renderer/src/i18n/locales/zh-CN";
import type { TranslateFn } from "../../../src/renderer/src/i18n";
import { displayInteractiveMessage } from "../../../src/shared/interactive-message";

function interactionData(text: string) {
	const match = text.match(/<!-- nekocode:interactive-context -->\n([\s\S]*)\n<!-- \/nekocode:interactive-context -->$/);
	return JSON.parse(match![1]);
}

describe("OpenUI component contract", () => {
	const parser = createParser(openuiLibrary.toJSONSchema(), openuiLibrary.root);
	test("all advertised examples parse against the real library", () => {
		for (const example of openuiPromptOptions.examples ?? []) {
			const code = example.replace(/^```openui\n/, "").replace(/\n```$/, "");
			const result = parser.parse(code);
			expect(["Card", "Stack"]).toContain(result.root?.typeName ?? "");
			expect(result.meta.errors).toEqual([]);
			expect(result.meta.unresolved).toEqual([]);
		}
	});
	test("application flex layouts and saved chat source arrays both remain valid", () => {
		for (const code of [
			'root = Stack([row])\nrow = Stack([card], "row", "m", "stretch", "start", true)\ncard = Card([TextContent("Content")], "sunk")',
			'root = Card([CardHeader("Legacy")], [{title: "Docs", sourceName: "Example", url: "https://example.com"}])',
		]) {
			const result = parser.parse(code);
			expect(result.meta.errors).toEqual([]);
			expect(result.meta.unresolved).toEqual([]);
		}
	});
	test("tables, charts and tabs compose in a reply", () => {
		const result = parser.parse(`root = Card([tabs])
tabs = Tabs([tab1, tab2])
tab1 = TabItem("table", "Table", [table])
tab2 = TabItem("chart", "Chart", [chart])
table = Table([labels, values])
labels = Col("Quarter", ["Q1", "Q2"])
values = Col("Tasks", [3, 5])
chart = BarChart(["Q1", "Q2"], [series])
series = Series("Tasks", [3, 5])`);
		expect(result.root?.typeName).toBe("Card");
		expect(result.meta.errors).toEqual([]);
		expect(result.meta.unresolved).toEqual([]);
	});
	test("application action signatures are registered in the parser and prompt", () => {
		for (const step of ['@OpenFile("src/main/index.ts", 12)', '@OpenTask("task-1")', '@SubmitToAgent("Continue", {path: "src/main/index.ts", count: 0})']) {
			const result = parser.parse(`root = Card([buttons])\nbuttons = Buttons([button])\nbutton = Button("Run", ${step})`);
			expect(result.meta.errors).toEqual([]);
			expect(result.meta.unresolved).toEqual([]);
		}
		const prompt = openuiLibrary.prompt(openuiPromptOptions);
		for (const name of ["OpenFile", "OpenTask", "SubmitToAgent"]) expect(prompt).toContain(`@${name}(`);
	});
	test("the main-process prompt matches the renderer without importing React at runtime", () => {
		const saved = readFileSync(new URL("../../../src/main/openui-system-prompt.txt", import.meta.url), "utf8");
		expect(saved).toBe(openuiLibrary.prompt(openuiPromptOptions).trim() + "\n");
		for (const component of ["Stack", "Card", "Modal", "Image", "CodeBlock", "Slider", "DatePicker", "EditableTable", "FollowUpBlock"]) expect(openuiLibrary.components).toHaveProperty(component);
	});
});

for (const [language, messages] of Object.entries({ en, zhCN })) {
	const t: TranslateFn = (key, params) => messages[key].replace(/\{(\w+)\}/g, (match, name) => String(params?.[name] ?? match));
	test(`${language}: a form submission preserves all values and action context in a user turn`, () => {
		const event: ActionEvent = {
			type: "continue_conversation", humanFriendlyMessage: "Continue with this plan",
			params: { context: { id: 42 } }, formState: { requirements: { goal: { value: "Build a dashboard", componentType: "Input" }, enabled: false, count: 0 } },
		};
		const request = openuiActionRequest(event, t)!;
		expect(request.text).toContain(event.humanFriendlyMessage);
		expect(interactionData(request.text)).toEqual({ version: 1, params: event.params, formState: event.formState });
		expect(displayInteractiveMessage(request.text)).toBe(event.humanFriendlyMessage);
		expect(Object.keys(request)).toEqual(["text"]);
		expect(openuiActionRequest({ ...event, type: "open_url" }, t)).toBeNull();
		expect(openuiActionRequest({ ...event, humanFriendlyMessage: " " }, t)).toBeNull();
	});
}

describe("application action dispatch", () => {
	const t: TranslateFn = (key, params) => en[key].replace(/\{(\w+)\}/g, (match, name) => String(params?.[name] ?? match));
	const event = (type: string, params: Record<string, unknown>): ActionEvent => ({ type, params, humanFriendlyMessage: "Run" });
	test("file and task actions call only their registered host capability", async () => {
		const calls: unknown[] = [];
		const handlers = {
			openFile: (path: string, line?: number) => { calls.push(["file", path, line]); },
			openTask: (id: string) => { calls.push(["task", id]); },
			send: () => { throw new Error("Must not call agent"); },
		};
		await dispatchOpenUIAction(event("OpenFile", { path: "src/main/index.ts", line: 12 }), handlers, t);
		await dispatchOpenUIAction(event("OpenTask", { taskId: "task-1" }), handlers, t);
		expect(calls).toEqual([["file", "src/main/index.ts", 12], ["task", "task-1"]]);
	});
	test("OpenUI's runtime evaluates custom steps into dispatcher-compatible params", async () => {
		const actions = openuiLibrary.toJSONSchema().actions;
		for (const [expression, expectedName, expectedParams] of [
			['@OpenFile("src/main/index.ts", 12)', "OpenFile", { path: "src/main/index.ts", line: 12 }],
			['@OpenFile("src/main/index.ts")', "OpenFile", { path: "src/main/index.ts" }],
			['@OpenTask("task-1")', "OpenTask", { taskId: "task-1" }],
			['@SubmitToAgent("Continue", {enabled: false, count: 0})', "SubmitToAgent", { message: "Continue", context: { enabled: false, count: 0 } }],
		] as const) {
			const plan = evaluate(parseExpression(tokenize(expression)), { getState: () => undefined, resolveRef: () => undefined, actions }) as { steps: Array<{ type: string; name: string; params: Record<string, unknown> }> };
			expect(plan.steps).toHaveLength(1);
			const step = plan.steps[0]!;
			expect(step.type).toBe("custom_action");
			expect(step.name).toBe(expectedName);
			expect(step.params).toEqual(expectedParams);
			await dispatchOpenUIAction(event(step.name, step.params), { openFile: () => {}, openTask: () => {}, send: () => {} }, t);
		}
	});
	test("invalid paths, line numbers, unknown actions and unavailable capabilities never reach the host", async () => {
		let calls = 0;
		const handlers = { openFile: () => { calls++; }, openTask: () => { calls++; }, send: () => { calls++; } };
		for (const path of ["../secret", "src/../../secret", "C:\\secret", "/etc/passwd", "\\\\host\\share", "https://example.com", "src\u0000/file", "src//file"]) {
			await expect(dispatchOpenUIAction(event("OpenFile", { path }), handlers, t)).rejects.toThrow();
		}
		for (const line of [0, -1, 1.5, "12"]) await expect(dispatchOpenUIAction(event("OpenFile", { path: "src/file.ts", line }), handlers, t)).rejects.toThrow();
		for (const action of [event("OpenFile", { path: "src/file.ts", command: "bad" }), event("OpenTask", { taskId: " " }), event("Execute", { command: "bad" })]) {
			await expect(dispatchOpenUIAction(action, handlers, t)).rejects.toThrow();
		}
		await expect(dispatchOpenUIAction(event("OpenFile", { path: "src/file.ts" }), {}, t)).rejects.toThrow();
		await expect(dispatchOpenUIAction(event("OpenTask", { taskId: "task-1" }), { ...handlers, disabled: true }, t)).rejects.toThrow();
		expect(calls).toBe(0);
	});
	test("agent submissions preserve structured context and form values without changing permissions", async () => {
		const requests: unknown[] = [];
		const context = { path: "src/main/index.ts", count: 0, enabled: false };
		const formState = { requirements: { goal: { value: "Implement" } } };
		await dispatchOpenUIAction({ ...event("SubmitToAgent", { message: "Continue", context }), formState }, { send: request => { requests.push(request); } }, t);
		expect(requests).toHaveLength(1);
		const request = requests[0] as { text: string };
		expect(Object.keys(request)).toEqual(["text"]);
		expect(request.text).toContain("Continue");
		expect(interactionData(request.text)).toEqual({ version: 1, params: { context }, formState });
		expect(displayInteractiveMessage(request.text)).toBe("Continue");
		await expect(dispatchOpenUIAction(event("SubmitToAgent", { message: " " }), { send: () => {} }, t)).rejects.toThrow();
	});
	test("asynchronous host failures are reported to the caller", async () => {
		await expect(dispatchOpenUIAction(event("OpenFile", { path: "missing.ts" }), { openFile: async () => { throw new Error("Missing file"); } }, t)).rejects.toThrow("Missing file");
	});
	test("host navigation checks task membership and project file access", async () => {
		const calls: unknown[] = [];
		const scope: OpenUIHostScope = {
			identity: {}, active: true, disabled: false, cwd: "project", sessionId: "session-1", tasks: [{ id: "task-1" }],
			onOpenFile: path => { calls.push(["file", path]); },
			onOpenTask: id => { calls.push(["task", id]); },
		};
		const host = createOpenUIHostActions(() => scope, async (cwd, path) => { calls.push(["read", cwd, path]); });
		await host.openFile("src/file.ts", 12);
		await host.openTask("task-1");
		await expect(host.openTask("another-session-task")).rejects.toThrow("Task unavailable");
		scope.tasks = [];
		await expect(host.openTask("task-1")).rejects.toThrow("Task unavailable");
		expect(calls).toEqual([["read", "project", "src/file.ts"], ["file", "src/file.ts:12"], ["task", "task-1"]]);
	});
	test("pending file checks cannot navigate after a session switch, unmount or busy transition", async () => {
		for (const transition of ["session", "unmount", "busy", "unavailable"] as const) {
			let navigated = false;
			const scope: OpenUIHostScope = { identity: {}, active: true, disabled: false, cwd: "project", sessionId: "session-1", onOpenFile: () => { navigated = true; } };
			let finish!: () => void;
			const host = createOpenUIHostActions(() => scope, () => new Promise<void>(resolve => { finish = resolve; }));
			const pending = host.openFile("src/file.ts");
			if (transition === "session") scope.identity = {};
			if (transition === "unmount") scope.active = false;
			if (transition === "busy") scope.disabled = true;
			if (transition === "unavailable") scope.onOpenFile = undefined;
			finish();
			await expect(pending).rejects.toThrow("Session changed");
			expect(navigated).toBe(false);
		}
	});
	test("a denied or missing project file never opens a preview", async () => {
		let navigated = false;
		const host = createOpenUIHostActions(() => ({ identity: {}, active: true, disabled: false, cwd: "project", sessionId: "session-1", onOpenFile: () => { navigated = true; } }), async () => { throw new Error("File unavailable"); });
		await expect(host.openFile("missing.ts")).rejects.toThrow("File unavailable");
		expect(navigated).toBe(false);
	});
});

test("only valid HTTP links can use the application opener", () => {
	expect(openuiWebUrl("https://example.com/docs?q=1")).toBe("https://example.com/docs?q=1");
	expect(openuiWebUrl("http://localhost:5173")).toBe("http://localhost:5173/");
	for (const value of ["javascript:alert(1)", "data:text/html,evil", "file:///etc/passwd", "https://", "/local", "https://user:password@example.com", null]) {
		expect(openuiWebUrl(value)).toBeNull();
	}
});
