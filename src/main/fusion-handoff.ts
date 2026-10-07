import type { TaskInput, TaskStep } from "../shared/workflow";
import { isShellTool } from "../shared/hooks";

/** Checked before creating a worker so a bad handoff never acquires write ownership. */
export function fusionTaskError(input: unknown): string | undefined {
	const task = input as Partial<TaskInput> | null;
	if (task?.kind !== "worker") return;
	const plan = task.executionPlan;
	const list = (value: unknown, required = false): value is string[] =>
		Array.isArray(value) && value.length <= 20 && (!required || value.length > 0) &&
		value.every((item) => typeof item === "string" && !!item.trim() && item.length <= 2000);
	if (!plan || !list(plan.steps, true) || !list(plan.constraints) ||
		!list(plan.acceptanceCriteria, true) || !plan.verification ||
		!["run", "skip"].includes(plan.verification.mode) || !list(plan.verification.checks)) {
		return "Fusion worker requires executionPlan: ordered steps, constraints, acceptanceCriteria and verification { mode: run|skip, checks }. Lead must decide the plan before Sidekick executes.";
	}
	if (plan.verification.mode === "run" && !plan.verification.checks.length)
		return "Fusion verification=run requires concrete checks; use skip with a constraint explaining why verification is excluded.";
	if (plan.verification.mode === "skip" && (plan.verification.checks.length || !plan.constraints.length))
		return "Fusion verification=skip requires empty checks and a constraint explaining the verification restriction.";
}

export function taskHandoffPrompt(input: TaskInput): string {
	const plan = input.executionPlan;
	return input.prompt + (plan ? "\n\n## Lead 执行计划（按此实施，不自行重新设计）\n" +
		JSON.stringify(plan, null, 2) + (plan.verification.mode === "skip"
			? "\n验证被明确排除：不要运行测试、构建或浏览器验证；交付注明未验证。"
			: "\n执行指定检查，报告命令、结果和未覆盖的验收条件；工具不可用或检查失败时返回证据，不声称通过。") : "") +
		(input.designSpec ? "\n\n## Lead 视觉设计规格\n" + input.designSpec +
			"\n\n按此规格实施；不要自行改变构图、配色、比例或动画风格。仅自行决定不影响视觉结果的实现细节。规格缺失或冲突且会改变视觉结果时，停止相关部分并把具体问题返回 Lead。完成说明列出对应实现及任何偏差，不要声称已进行未执行的视觉检查。" : "") +
		"\n\nDeclared writable paths: " + (input.writablePaths.join(", ") || "none") +
		". Report changes and checks honestly so Lead can integrate and verify. Use only tools actually available.";
}

/** Bounded, runtime-observed evidence, not the model's claim of passing checks. */
export class FusionExecutionEvidence {
	private records: string[] = [];
	record(step: TaskStep): void {
		if (step.kind !== "tool" || step.status === "running" ||
			(!isShellTool(step.toolName) && step.status !== "error")) return;
		this.records.push(JSON.stringify({
			tool: step.toolName, args: step.args.slice(0, 160), status: step.status,
			output: step.output?.slice(-500),
		}));
		if (this.records.length > 8) this.records.shift();
	}
	appendTo(result: string): string {
		return result + "\n\n## Runtime execution evidence (last 8 command/error results; tool success is not acceptance)\n" +
			(this.records.join("\n") || "No completed shell calls or tool errors observed. Checks are not proven by this record.");
	}
}
