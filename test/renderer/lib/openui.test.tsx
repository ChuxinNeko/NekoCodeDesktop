import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createParser } from "@openuidev/react-lang";
import type { ActionEvent } from "@openuidev/react-lang";
import { openuiLibrary, openuiPromptOptions } from "../../../src/renderer/src/lib/openuiLibrary";
import { openuiActionRequest, openuiWebUrl } from "../../../src/renderer/src/lib/openuiActions";
import { en } from "../../../src/renderer/src/i18n/locales/en";
import { zhCN } from "../../../src/renderer/src/i18n/locales/zh-CN";
import type { TranslateFn } from "../../../src/renderer/src/i18n";

describe("OpenUI component contract", () => {
	const parser = createParser(openuiLibrary.toJSONSchema(), openuiLibrary.root);
	test("all advertised examples parse against the real library", () => {
		for (const example of openuiPromptOptions.examples ?? []) {
			const code = example.replace(/^```openui\n/, "").replace(/\n```$/, "");
			const result = parser.parse(code);
			expect(result.root?.typeName).toBe("Card");
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
	test("the main-process prompt matches the renderer without importing React at runtime", () => {
		const saved = readFileSync(new URL("../../../src/main/openui-system-prompt.txt", import.meta.url), "utf8");
		expect(saved).toBe(openuiLibrary.prompt(openuiPromptOptions).trim() + "\n");
		expect(openuiLibrary.components).not.toHaveProperty("Image");
		expect(openuiLibrary.components).not.toHaveProperty("CodeBlock");
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
		expect(request.text).toContain(JSON.stringify(event.formState, null, 2));
		expect(request.text).toContain(JSON.stringify(event.params, null, 2));
		expect(Object.keys(request)).toEqual(["text"]);
		expect(openuiActionRequest({ ...event, type: "open_url" }, t)).toBeNull();
		expect(openuiActionRequest({ ...event, humanFriendlyMessage: " " }, t)).toBeNull();
	});
}

test("only valid HTTP links can use the application opener", () => {
	expect(openuiWebUrl("https://example.com/docs?q=1")).toBe("https://example.com/docs?q=1");
	expect(openuiWebUrl("http://localhost:5173")).toBe("http://localhost:5173/");
	for (const value of ["javascript:alert(1)", "data:text/html,evil", "file:///etc/passwd", "https://", "/local", "https://user:password@example.com", null]) {
		expect(openuiWebUrl(value)).toBeNull();
	}
});
