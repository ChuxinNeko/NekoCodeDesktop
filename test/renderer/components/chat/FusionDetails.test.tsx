import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { TaskCard } from "../../../../src/renderer/src/components/chat/AgentTask";
import { UsageDetails } from "../../../../src/renderer/src/components/chat/UsagePanel";
import type { TurnUsage } from "../../../../src/shared/agent";
import type { WorkflowTask } from "../../../../src/shared/workflow";

const render = (content: React.ReactNode) => renderToString(<I18nProvider>{content}</I18nProvider>);
describe("Fusion outcome and cost display", () => {
	test("a finished run needing a decision is not labeled as accepted", () => {
		const task: WorkflowTask = { id: "worker", kind: "worker", description: "Implement", writablePaths: ["."],
			status: "completed", outcome: "needs_decision", startedAt: 1, endedAt: 2, steps: [], result: "Unverified" };
		expect(render(<TaskCard task={task} />)).toMatch(/需要主导决策|Needs Lead decision/);
		task.outcome = "completed";
		expect(render(<TaskCard task={task} />)).toMatch(/待主导审查|Awaiting Lead review/);
	});
	test("shows actual models and maintenance categories after routing", () => {
		const primary: TurnUsage = { provider: "a", model: "lead", calls: 1, input: 1, output: 1,
			cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0.01 };
		const usage: TurnUsage = { ...primary, fusion: { lead: primary,
			sidekick: { provider: "b", model: "configured-side", usage: primary }, breakdown: [
				{ taskId: "worker-1", kind: "inference", usage: { ...primary, provider: "b", model: "actual-side" } },
				{ taskId: "worker-1", kind: "compaction", usage: primary },
				{ taskId: "worker-1", kind: "cache-warm", usage: primary },
			] } };
		const html = render(<UsageDetails usage={usage} />).replaceAll("<!-- -->", "");
		expect(html).toContain("b/actual-side");
		expect(html).not.toContain("configured-side");
		expect(html).toMatch(/上下文压缩|Context compaction/);
		expect(html).toMatch(/缓存保温|Cache warming/);
	});
});
