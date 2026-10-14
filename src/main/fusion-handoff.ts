import type { TaskInput, TaskStep } from "../shared/workflow";
import { isShellTool } from "../shared/hooks";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { FusionTaskReport } from "../shared/workflow";

const shortText = () => Type.String({ minLength: 1, maxLength: 2000 });
export const FUSION_COMPACT_HANDOFF_SCHEMA = Type.Object({
	instruction: Type.String({ minLength: 1, maxLength: 6000 }),
	path: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
	paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 20 })),
	acceptanceCriterion: shortText(),
	check: Type.Optional(shortText()),
	skipReason: Type.Optional(shortText()),
}, { additionalProperties: false });
export const FUSION_RESUME_HANDOFF_SCHEMA = Type.Object({
	resume: Type.Literal(true),
	instruction: Type.String({ minLength: 1, maxLength: 6000 }),
	resolution: shortText(),
}, { additionalProperties: false });

/** Small inline edits and corrections reuse runtime plans instead of regenerating them. */
export class FusionInlineHandoffState {
	private previous?: TaskInput;
	private failed = new Map<string, number>();
	private signature(input: TaskInput): string {
		return createHash("sha256").update(JSON.stringify({ prompt: input.prompt, paths: input.writablePaths,
			plan: input.executionPlan, design: input.designSpec })).digest("hex");
	}
	prepare(args: unknown): TaskInput {
		if (!args || typeof args !== "object") throw new Error("Fusion handoff requires an object");
		const value = args as Record<string, unknown>;
		if (typeof value.instruction === "string" && value.instruction.length > 6000) throw new Error("Instruction exceeds 6000 characters; provide only new decisions");
		let input: TaskInput;
		if (value.resume === true) {
			if (!this.previous) throw new Error("No inline plan to resume in this user task; provide a new handoff");
			if (typeof value.instruction !== "string" || !value.instruction.trim() || typeof value.resolution !== "string" || !value.resolution.trim())
				throw new Error("Resume needs a concrete correction and resolution of the previous blocker");
			input = { ...this.previous, prompt: value.instruction + "\nLead resolution: " + value.resolution,
				executionPlan: { ...this.previous.executionPlan!, steps: value.instruction.match(/[\s\S]{1,2000}/g)! } };
		} else if (value.executionPlan && Array.isArray(value.writablePaths)) {
			// Object-root gateway schemas allow both compact and full fields. An
			// explicit full execution contract wins over an incidental instruction.
			input = { ...value, kind: "worker", prompt: value.prompt ?? value.instruction,
				description: value.description ?? String(value.instruction ?? "Lead execution plan").slice(0, 200) } as TaskInput;
		} else if (typeof value.instruction === "string") {
			const paths = Array.isArray(value.paths) ? value.paths : typeof value.path === "string" ? [value.path] : [];
			if (value.paths !== undefined && value.path !== undefined) throw new Error("Provide path or paths, not both");
			if (!value.instruction.trim() || !paths.length || paths.length > 20 ||
				!paths.every(path => typeof path === "string" && !!path.trim() && path.length <= 1000) ||
				typeof value.acceptanceCriterion !== "string" || !value.acceptanceCriterion.trim())
				throw new Error("Compact handoff requires instruction, path or paths, and acceptanceCriterion");
			const skip = typeof value.skipReason === "string" && !!value.skipReason.trim();
			// Conflicting optional fields must never enable checks against an
			// explicit exclusion. Prefer the stricter skip contract and expose it.
			const check = !skip && typeof value.check === "string" && !!value.check.trim();
			if (!check && !skip) throw new Error("Provide exactly one concrete check or explicit skipReason");
			input = { kind: "worker", description: value.instruction.slice(0, 200), prompt: value.instruction,
				writablePaths: paths as string[], executionPlan: { steps: value.instruction.match(/[\s\S]{1,2000}/g)!,
					constraints: ["Preserve user changes and all shared user restrictions.", ...(skip ? [String(value.skipReason)] : [])],
					acceptanceCriteria: [value.acceptanceCriterion], verification: check ? { mode: "run", checks: [String(value.check)] } : { mode: "skip", checks: [] } } };
		} else input = args as TaskInput;
		const error = fusionTaskError(input);
		if (error) throw new Error(error);
		if (input.kind !== "worker" || !input.writablePaths?.length) throw new Error("Implementation needs worker and writablePaths");
		if ((this.failed.get(this.signature(input)) ?? 0) >= 2)
			throw new Error("This unchanged Fusion plan failed twice. Do not repeat it: collect missing evidence and supply a new concrete decision/resolution, or report the blocker to the user.");
		return input;
	}
	accept(input: TaskInput): void { this.previous = structuredClone(input); }
	snapshot() { return { previous: this.previous, failed: [...this.failed] }; }
	restore(value: unknown): boolean {
		const v = value as ReturnType<FusionInlineHandoffState["snapshot"]>;
		if (!v || (v.previous && (fusionTaskError(v.previous) || v.previous.kind !== "worker" ||
			typeof v.previous.prompt !== "string" || !v.previous.prompt.trim() || v.previous.prompt.length > 20000 ||
			typeof v.previous.description !== "string" || v.previous.description.length > 2000 ||
			(v.previous.designSpec !== undefined && (typeof v.previous.designSpec !== "string" || v.previous.designSpec.length > 20000)) ||
			!Array.isArray(v.previous.writablePaths) || !v.previous.writablePaths.length || v.previous.writablePaths.length > 20 ||
			!v.previous.writablePaths.every((path) => typeof path === "string" && path.length > 0 && path.length <= 1000))) ||
			!Array.isArray(v.failed) || v.failed.length > 100 || !v.failed.every((entry) => Array.isArray(entry) && entry.length === 2 &&
				typeof entry[0] === "string" && /^[a-f0-9]{64}$/.test(entry[0]) && Number.isSafeInteger(entry[1]) && entry[1] >= 0 && entry[1] <= 10000)) return false;
		this.previous = v.previous ? structuredClone(v.previous) : undefined; this.failed = new Map(v.failed); return true;
	}
	report(report?: FusionTaskReport, input = this.previous): void {
		if (!input) return;
		const signature = this.signature(input);
		if (report?.outcome === "completed") { this.failed.delete(signature); return; }
		this.failed.set(signature, (this.failed.get(signature) ?? 0) + 1);
	}
	reset(): void { this.previous = undefined; this.failed.clear(); }
}

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
	if (plan.decisionBrief && (typeof plan.decisionBrief.objective !== "string" ||
		!plan.decisionBrief.objective.trim() || plan.decisionBrief.objective.length > 2000 ||
		!list(plan.decisionBrief.decisions, true) || !list(plan.decisionBrief.evidence) || !list(plan.decisionBrief.stopConditions, true)))
		return "Fusion decisionBrief needs an objective, concrete decisions, evidence locations and stopConditions for returning to Lead.";
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
	private commands = 0;
	private failedCommands = 0;
	record(step: TaskStep): void {
		if (step.kind !== "tool" || step.status === "running" ||
			(!isShellTool(step.toolName) && step.status !== "error")) return;
		if (isShellTool(step.toolName)) {
			this.commands++;
			if (step.status === "error") this.failedCommands++;
		}
		this.records.push(JSON.stringify({
			tool: step.toolName, args: step.args.slice(0, 160), status: step.status,
			output: step.output?.slice(-500),
		}));
		if (this.records.length > 8) this.records.shift();
	}
	summary(): { observedCommands: number; failedCommands: number } {
		return { observedCommands: this.commands, failedCommands: this.failedCommands };
	}
	appendTo(result: string): string {
		return result + "\n\n## Runtime execution evidence (last 8 command/error results; tool success is not acceptance)\n" +
			(this.records.join("\n") || "No completed shell calls or tool errors observed. Checks are not proven by this record.");
	}
}
