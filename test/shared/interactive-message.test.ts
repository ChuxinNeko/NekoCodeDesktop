import { expect, test } from "bun:test";
import { displayInteractiveMessage, interactiveMessage } from "../../src/shared/interactive-message";
import { projectMessages, CellProjector } from "../../src/main/agent-projection";

test("interaction data survives in model history while live and reopened transcripts show only the request", () => {
	const message = "请把调查扩展为完整报告";
	const text = interactiveMessage(message, { context: { scope: "openui-integration", version: 1 } }, { requirements: { priority: { value: "high" }, enabled: false, count: 0 } });
	expect(text).toContain('"scope": "openui-integration"');
	expect(text).toContain('"value": "high"');
	const persisted = { role: "user", content: text, timestamp: 123 };
	expect(projectMessages([persisted])).toMatchObject([{ type: "user", text: message }]);
	const projector = new CellProjector();
	projector.rebuild([persisted], true);
	expect(projector.cells()).toMatchObject([{ type: "user", text: message }]);
	projector.rebuild([persisted], false);
	expect(projector.cells()).toMatchObject([{ type: "user", text: message }]);
	expect(persisted.content).toBe(text);
});

test("even a button without context displays as an ordinary user message", () => {
	expect(displayInteractiveMessage(interactiveMessage("继续"))).toBe("继续");
});

test("saved Chinese and English action messages lose technical labels and JSON in the transcript", () => {
	for (const text of [
		'来自交互式回复的用户操作：请继续\n操作上下文：\n{ "context": { "scope": "openui" } }\n提交的表单值：\n{ "priority": "high" }',
		'User action from an interactive response: 请继续\nAction context:\n{ "context": { "scope": "openui" } }\nSubmitted form values:\n{ "priority": "high" }',
		'来自交互式回复的用户操作：请继续',
	]) {
		expect(displayInteractiveMessage(text)).toBe("请继续");
		expect(projectMessages([{ role: "user", content: text, timestamp: 1 }])).toMatchObject([{ text: "请继续" }]);
	}
});

test("ordinary prompts and invalid or incomplete context blocks stay visible", () => {
	for (const text of [
		"请解释这个 JSON：{\"version\":1}",
		'用户操作说明\n操作上下文：\n{"id":1}',
		'继续\n\n<!-- nekocode:interactive-context -->\ninvalid\n<!-- /nekocode:interactive-context -->',
		'继续\n\n<!-- nekocode:interactive-context -->\n{"version":2,"params":{},"formState":{}}\n<!-- /nekocode:interactive-context -->',
		'来自交互式回复的用户操作：解释\n操作上下文：\n这不是 JSON',
	]) expect(displayInteractiveMessage(text)).toBeNull();
});
