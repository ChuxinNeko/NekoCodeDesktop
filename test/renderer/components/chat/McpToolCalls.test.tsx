import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { ToolCellData } from "../../../../src/shared/transcript";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { en } from "../../../../src/renderer/src/i18n/locales/en";
import { ToolCall, toolSummary } from "../../../../src/renderer/src/components/chat/ToolCalls";

const cell: ToolCellData = { id: "mcp-call", type: "tool", toolCallId: "mcp-call", toolName: "mcp__Linear_API__search_issues",
	args: { query: "Investigate streaming", filters: { status: ["open"] } }, output: "Found two issues", status: "done", timestamp: 1 };
const summary = (value: ToolCellData) => toolSummary(value, (key) => en[key]);
const render = (value: ToolCellData, active = false) => renderToString(<I18nProvider><ToolCall cell={value} active={active} /></I18nProvider>);

describe("MCP tool presentation", () => {
	test("uses a compact tool row and readable server/tool labels instead of a raw namespaced title", () => {
		const html = render(cell);
		expect(summary(cell)).toBe("Call tool Linear_API / search_issues");
		expect(html).toContain("tool-line");
		expect(html).toContain("Linear_API / search_issues");
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain(`title="${cell.toolName}"`);
		expect(html.replace(/<[^>]*>/g, "")).not.toContain(cell.toolName);
		expect(html).not.toContain("Investigate streaming");
	});
	test("uses the actual server label recorded by MCP and keeps underscores in the tool ID", () => {
		expect(summary({ ...cell, details: { server: "Linear API", tool: "search_issues" } })).toBe("Call tool Linear API / search_issues");
		expect(summary({ ...cell, details: { server: "", tool: 42 } })).toBe(summary(cell));
	});
	test("can expand nested arguments while a call has no output yet", () => {
		expect(render({ ...cell, output: "", status: "running" }, true)).toContain('aria-expanded="false"');
		expect(render({ ...cell, args: {}, output: "", status: "running" }, true)).not.toContain("aria-expanded");
	});
	test("keeps failures and stopped history in the common tool status presentation", () => {
		expect(render({ ...cell, status: "error" })).toContain("text-destructive");
		expect(render({ ...cell, status: "running" }, false)).not.toContain("shimmer");
		expect(render({ ...cell, status: "running" }, true)).not.toContain("shimmer");
		expect(render({ ...cell, status: "running" }, true)).toContain('role="status"');
		expect(render({ ...cell, status: "running" }, false)).not.toContain('role="status"');
	});
	test("keeps unrelated extension tools on the normal fallback", () => {
		expect(summary({ ...cell, toolName: "custom_tool", args: { path: "app.ts" } })).toBe("custom_tool app.ts");
	});
});
