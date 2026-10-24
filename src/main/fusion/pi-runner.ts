import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRunner, AgentTurn, CompactRequest, ExecuteRequest, FusionMessage, FusionPlan, PlanRequest, SynthesisRequest } from "./reference/core/types";

export const FUSION_PLAN_SCHEMA = Type.Object({
	complexity: Type.Number({ minimum: 0, maximum: 1 }), mainTask: Type.String({ minLength: 1 }),
	sidekickTasks: Type.Array(Type.Object({ profile: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		task: Type.String({ minLength: 1 }) }), { maxItems: 6 }),
});
export interface PiFusionStage {
	kind: "plan" | "execute" | "synthesize" | "compact" | "review";
	role: "main" | "sidekick";
	model: PlanRequest["model"];
	messages: FusionMessage[];
	instructions: string;
	activeTools?: string[];
	signal?: AbortSignal;
	onToolEvent?: ExecuteRequest["onToolEvent"];
	onStreamPart?: ExecuteRequest["onStreamPart"];
	/** One model message, including text sent before a tool call. */
	onAssistantMessage?: (text: string, interrupted: boolean) => void;
	/** Model-step cap; defaults to 1 for plan/compact and 20 otherwise. */
	maxSteps?: number;
	/**
	 * When set, the last allowed step keeps only these tools (plus the submit tool) and the
	 * model is told the budget is spent, so a capped stage still ends with a report or verdict.
	 */
	finalStepTools?: string[];
	/** Structured output tool installed for this stage; the stage ends once it is called. */
	submitTool?: { name: string; description: string; parameters: unknown };
	/** Extra tools for this actor stage (e.g. team_assign); they do not end the stage. */
	extraTools?: import("@earendil-works/pi-coding-agent").ToolDefinition[];
	/** Per-stage thinking level; defaults to the host's level for the role. */
	thinkingLevel?: import("../../shared/agent").ThinkingLevel;
	/** Reuse one actor across stages so a follow-up keeps its cached context. Release with driver.release(). */
	actor?: PiFusionActorHandle;
	teamMemberId?: string;
}
/** A persistent non-parent actor; the driver fills session and transform on first use. */
export interface PiFusionActorHandle { session?: AgentSession; transform?: AgentSession["agent"]["transformContext"]; extraToolNames?: Set<string> }
export type PiFusionStageResult = AgentTurn & { plan?: unknown; submitted?: unknown; steps?: number };

/** PI transport adapter for the reference AiSdkAgentRunner's four operations and prompts. */
export class PiFusionRunner implements AgentRunner {
	constructor(private readonly runStage: (request: PiFusionStage) => Promise<PiFusionStageResult>,
		private readonly additionalInstructions = "") {}
	async plan(request: PlanRequest): Promise<FusionPlan> {
		const profiles = request.workerProfiles ?? [];
		const planningPrompt = [
			"Plan this coding task for a frontier main agent and one cheaper sidekick.",
			"Delegate bounded research, tests, and mechanical edits. Keep architecture, risky changes, and final integration with main.",
			profiles.length === 0 ? "No named sidekick profiles are available. Set profile to null for every sidekick task." :
				`Available sidekick profiles (assign only when the specialization fits; otherwise set profile to null):\n${profiles.map(profile =>
					`- ${profile.name}: ${profile.description ?? profile.instructions.split("\n", 1)[0] ?? "Custom worker"}`).join("\n")}`,
			`Current task: ${request.prompt}`, this.additionalInstructions,
		].filter(Boolean).join("\n");
		const result = await this.runStage({ kind: "plan", role: "main", model: request.model, signal: request.signal,
			messages: [...request.context, { role: "user", content: planningPrompt }],
			instructions: "Return the structured plan using fusion_submit_plan. Do not execute the task during planning." });
		const value = result.plan ?? JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
		const { Value } = await import("typebox/value");
		if (!Value.Check(FUSION_PLAN_SCHEMA, value)) throw new Error("Invalid Fusion plan: expected complexity, mainTask and at most six typed sidekick tasks");
		const plan = value as { complexity: number; mainTask: string; sidekickTasks: { profile: string | null; task: string }[] };
		return { complexity: plan.complexity, mainTask: plan.mainTask,
			sidekickTasks: plan.sidekickTasks.map(item => item.task),
			sidekickAssignments: plan.sidekickTasks.map(({ profile, task }) => ({ task, ...(profile === null ? {} : { profile }) })) };
	}
	execute(request: ExecuteRequest): Promise<AgentTurn> {
		const roleInstructions = request.role === "main" ?
			"You are the authoritative coding agent. Make careful, integrated changes and verify them." :
			"You are the sidekick coding agent. Complete the bounded task independently. Prefer mechanical, well-tested changes and report uncertainty.";
		return this.runStage({ ...request, kind: "execute", messages: request.context,
			instructions: [roleInstructions, this.additionalInstructions, request.instructions].filter(Boolean).join("\n\n") });
	}
	synthesize(request: SynthesisRequest): Promise<AgentTurn> {
		const sidekick = request.sidekickResults.map((result, index) =>
			`Sidekick ${index + 1}${result.profile === undefined ? "" : ` (${result.profile})`}:\n${result.text}`).join("\n\n");
		return this.runStage({ ...request, role: "main", kind: "synthesize", messages: [...request.context, { role: "user",
			content: `Synthesize the answer to the current task:\n${request.prompt}\n\nMain work:\n${request.mainResult.text}\n\n${sidekick}` }],
			instructions: ["You are the authoritative main agent. Reconcile the work, reject incorrect sidekick suggestions, and return the final result.",
				"Format the answer as compact GitHub-flavored Markdown. Use real paragraphs for prose and bullets for lists; do not put every sentence on its own line.",
				this.additionalInstructions].filter(Boolean).join("\n\n") });
	}
	async compact(request: CompactRequest): Promise<string> {
		const result = await this.runStage({ ...request, kind: "compact", messages: request.context,
			instructions: "Compress the context into a concise continuation brief. Preserve decisions, changed files, failures, and remaining work." });
		return result.text;
	}
}
