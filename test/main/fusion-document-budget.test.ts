import { describe, expect, test } from "bun:test";
import { FusionDocumentBudget, FusionDocumentReviewBudget, isDocumentReviewTask, isDocumentScope, DOCUMENT_INVESTIGATION_LIMIT } from "../../src/main/fusion-document-budget";

describe("Fusion document assembly budget", () => {
	test("recognizes Chinese and English review-to-document requests, including escaped extension", () => {
		expect(isDocumentReviewTask("请基于当前 NekoCode 项目的真实代码，审查 Fusion 模式是否能节省 Lead 模型的 token，并把结果写入 docs/fusion-token-review\\.md。")).toBe(true);
		expect(isDocumentReviewTask("Audit the current code and write docs/review.md")).toBe(true);
		expect(isDocumentReviewTask("请审查代码并生成 docs/review.md")).toBe(true);
		expect(isDocumentReviewTask("Review the bug, write src/fix.ts and update docs/README.md")).toBe(false);
		for (const text of ["Review docs/fusion.md", "Write docs/fusion.md", "审查并修复 src/main/agent.ts"]) expect(isDocumentReviewTask(text)).toBe(false);
	});
	test("an explicit single-document restriction is retained across restoration", () => {
		const budget = new FusionDocumentReviewBudget(); budget.start("审查代码，并把结果写入 docs/review\\.md。只允许创建或修改这份文档，不修改任何源码。");
		expect(budget.explicitDocumentPath).toBe("docs/review.md");
		const restored = new FusionDocumentReviewBudget(); expect(restored.restore(budget.snapshot())).toBe(true);
		expect(restored.explicitDocumentPath).toBe("docs/review.md");
	});
	test("Lead location cap is shared by the user task, with a separate bounded acceptance phase", () => {
		const budget = new FusionDocumentReviewBudget(); budget.start("审查代码并写入 docs/review.md");
		expect(budget.before("code_search")).toBeUndefined();
		expect(budget.before("code_search")).toBeUndefined();
		expect(budget.before("code_search")).toContain("maximum 2");
		for (let i = 0; i < 10; i++) expect(budget.before("read")).toBeUndefined();
		expect(budget.canRead).toBe(false);
		expect(budget.before("read")).toContain("12 read/code_search");
		expect(budget.before("fusion_implement")).toBeUndefined();
		budget.handoff(); expect(budget.canRead).toBe(true); expect(budget.canSearch).toBe(false);
		for (let i = 0; i < 4; i++) { budget.before("read"); budget.handoff(); }
		expect(budget.before("read")).toContain("4 reads across all handoffs");
		budget.start("审查代码并写入 docs/another.md"); expect(budget.canSearch).toBe(true);
		budget.reset(); expect(budget.document).toBe(false);
	});
	test("a read-only/code task is not constrained by the document audit heuristic", () => {
		const budget = new FusionDocumentReviewBudget(); budget.start("Review src/a.ts and fix its bug");
		for (let i = 0; i < 100; i++) expect(budget.before("code_search")).toBeUndefined();
		expect(budget.canSearch).toBe(true);
	});
	test("applies only to explicit document scopes", () => {
		expect(isDocumentScope(["docs/review.md", "notes.TXT"])).toBe(true);
		for (const paths of [[], ["."], ["docs"], ["docs/a.md", "src/a.ts"]]) expect(isDocumentScope(paths)).toBe(false);
	});
	test("counts repeated and denied investigation attempts, but permits writes and reports", () => {
		const budget = new FusionDocumentBudget(); budget.start(["docs/review.md"]);
		for (let i = 0; i < DOCUMENT_INVESTIGATION_LIMIT; i++) expect(budget.before("read")).toBeUndefined();
		expect(budget.exhausted).toBe(true);
		expect(budget.before("grep")).toContain("budget exhausted");
		expect(budget.before("write")).toBeUndefined();
		expect(budget.before("fusion_review")).toBeUndefined();
		budget.observe("write", true); expect(budget.exhausted).toBe(true);
		budget.observe("write", false); expect(budget.exhausted).toBe(true);
		budget.observe("write", false, true); expect(budget.exhausted).toBe(false);
		budget.reset(); expect(budget.document).toBe(false);
	});
	test("ordinary code implementation keeps its tools unbounded by the document policy", () => {
		const budget = new FusionDocumentBudget(); budget.start(["src/a.ts"]);
		for (let i = 0; i < 100; i++) budget.before("read");
		expect(budget.exhausted).toBe(false);
	});
	test("document investigation accumulates across actual writes and re-handoffs", () => {
		const budget = new FusionDocumentBudget(); budget.start(["review.md"]);
		for (let cycle = 0; cycle < 3; cycle++) {
			for (let i = 0; i < 12; i++) expect(budget.before("read")).toBeUndefined();
			budget.observe("write", false, true); budget.start(["review.md"]);
		}
		expect(budget.exhausted).toBe(true); expect(budget.before("read")).toContain("exhausted");
		const restored = new FusionDocumentBudget(); expect(restored.restore(budget.snapshot())).toBe(true);
		expect(restored.exhausted).toBe(true);
	});
	test("larger audit scopes have bounded adaptive budgets and only one supplement", () => {
		const budget = new FusionDocumentReviewBudget(); budget.start("审查代码并生成 review.md\n" + Array.from({ length: 6 }, (_, i) => `${i + 1}. area`).join("\n"));
		expect(budget.snapshot().discoveryLimit).toBe(16); budget.handoff(); budget.supplement();
		const first = budget.snapshot(); budget.supplement(); expect(budget.snapshot()).toEqual(first);
		const restored = new FusionDocumentReviewBudget(); expect(restored.restore(first)).toBe(true); expect(restored.snapshot()).toEqual(first);
		expect(restored.restore({ ...first, discoveryLimit: 9999 })).toBe(false);
	});
});
