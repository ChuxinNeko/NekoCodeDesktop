import { describe, expect, test } from "bun:test";
import { Popover } from "@base-ui/react/popover";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { ContextUsageReport } from "../../../../src/renderer/src/components/chat/ContextGauge";
import type { ContextUsage } from "../../../../src/shared/agent";
import { AcpProjection } from "../../../../src/main/acp/projection";

const report = (context: ContextUsage) => renderToString(<I18nProvider><Popover.Root><ContextUsageReport context={context} /></Popover.Root></I18nProvider>);

describe("context report", () => {
	test("explains Codex rollout estimates and keeps unobserved tool definitions unknown", () => {
		const html = report({ used: 27300, window: 1000000, source: "acp", breakdownSource: "codex-rollout", breakdownEstimated: true, breakdown: { system: 1700, rules: 2100, skills: 3600, subagents: 1200, conversation: 1200 } });
		expect(html).toContain("ACP");
		expect(html).toContain("当前 Codex 会话的本地记录估算");
		expect(html.match(/>—</g)).toHaveLength(2);
		expect(html).toContain("~1.7K");
	});
	test("shows categorized estimates and model totals", () => {
		const html = report({ used: 17400, window: 256000, breakdownEstimated: true, breakdown: { system: 1700, tools: 3600, rules: 2100, skills: 3600, mcp: 4000, subagents: 1200, conversation: 1200 } });
		expect(html).toContain("17.4K");
		expect(html).toContain("256K");
		expect(html).toContain('aria-valuenow="7"');
		expect(html).toContain("~1.7K");
		expect(html).not.toContain("未分类上下文");
	});

	test("ACP totals reach the report without inventing a category breakdown", () => {
		const projection = new AcpProjection();
		expect(projection.apply({ sessionUpdate: "usage_update", used: 17400, size: 256000 })).toBe(true);
		const html = report(projection.context!);
		expect(html).toContain("ACP");
		expect(html).toContain("17.4K");
		expect(html.match(/>—</g)).toHaveLength(7);
		expect(html).toContain("未分类上下文");
	});

	test("rejects invalid ACP usage while retaining the last valid report, including zero usage", () => {
		const projection = new AcpProjection();
		projection.apply({ sessionUpdate: "usage_update", used: 0, size: 100 });
		for (const [used, size] of [[-1, 100], [NaN, 100], [Infinity, 100], [10, Infinity], [10, 0]]) {
			expect(projection.apply({ sessionUpdate: "usage_update", used, size })).toBe(false);
		}
		expect(projection.context).toEqual({ used: 0, window: 100, source: "acp" });
		expect(report(projection.context!)).toContain('aria-valuenow="0"');
	});

	test("caps the meter at capacity while preserving the actual over-limit usage", () => {
		const html = report({ used: 1200, window: 1000 });
		expect(html).toContain('aria-valuenow="100"');
		expect(html).toContain("120%");
		expect(html).toContain("1.2K");
	});
});
