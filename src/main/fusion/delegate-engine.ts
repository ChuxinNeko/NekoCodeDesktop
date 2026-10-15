import { Type } from "typebox";
import { FusionChangeTracker } from "./change-tracker";
import type { PiFusionActorHandle, PiFusionStage, PiFusionStageResult } from "./pi-runner";
import type { FusionEvent, FusionMessage, FusionUsage, SessionRecord, SessionStore, TokenUsage, ToolActivityEvent } from "./reference/core/types";

/**
 * Delegate strategy: Lead writes a brief, Sidekick does all reading/editing/testing,
 * Lead reviews one compact diff and either accepts, sends precise fixes back to the
 * same Sidekick actor, or takes over. Lead never re-reads the whole workspace.
 */
export const DELEGATE_BRIEF_SCHEMA = Type.Object({
	route: Type.Union([Type.Literal("delegate"), Type.Literal("lead")]),
	complexity: Type.Number({ minimum: 0, maximum: 1 }),
	brief: Type.String({ minLength: 1 }),
	workItems: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 6 })),
	reviewFocus: Type.String(),
});
export const DELEGATE_REVIEW_SCHEMA = Type.Object({
	verdict: Type.Union([Type.Literal("accept"), Type.Literal("revise"), Type.Literal("takeover")]),
	issues: Type.Array(Type.String({ minLength: 1 }), { maxItems: 12 }),
	answer: Type.String(),
});
type Brief = { route: "delegate" | "lead"; complexity: number; brief: string; workItems?: string[]; reviewFocus: string };
type Review = { verdict: "accept" | "revise" | "takeover"; issues: string[]; answer: string };

export const REVIEW_TOOLS = ["read", "grep", "find", "ls", "bash"];

export interface DelegateEngineOptions {
	run(stage: PiFusionStage): Promise<PiFusionStageResult>;
	release(handle: PiFusionActorHandle): void;
	/** Put Lead's accepted answer on the parent transcript (review runs in a side actor). */
	appendFinal(text: string): Promise<void>;
	store: SessionStore & { latest?(): SessionRecord | undefined };
	cwd: string;
	models: { main: string; sidekick: string };
	instructions?: string;
	contextMessageLimit?: number;
	/** Sidekick fix rounds before Lead takes over. */
	maxRevisions?: number;
	sidekickSteps?: number;
	reviewSteps?: number;
	takeoverSteps?: number;
}
export interface DelegateRunRequest { prompt: string; signal?: AbortSignal; sessionId?: string; messages?: FusionMessage[] }

const BRIEF_INSTRUCTIONS = `You are the Lead engineer in a cost-aware pair. A cheaper Sidekick agent with full workspace tools will do ALL reading, editing and testing; you will review its diff afterwards. Spend few tokens: you cannot use workspace tools now, so do not guess file contents.
Call fusion_submit_brief once:
- route "delegate" (default): any task that needs reading, editing, running commands or investigating code.
- route "lead": only when no workspace access is needed (pure conversation/knowledge answer), or when the task is a single trivial edit you could finish in two or three tool calls.
- brief: a complete, self-contained work order for the Sidekick. Restate EVERY requirement and constraint from the user verbatim or more precisely (never drop or soften one), give a concrete approach and edge cases where the request implies them, the verification commands to run, and what must not be touched. Number the requirements so review can refer to them.
- workItems: when the task has several parts, 2–5 ordered, self-contained items (for example one per module, then tests, then final verification), each doable in about 10–15 tool calls and naming the requirement numbers it covers. Every item must change or verify something; never create a read-only "inspect/explore" item (reading is part of each item). Together they must cover every requirement. Use [] for small tasks.
- reviewFocus: private notes for your own later review (riskiest requirements, likely mistakes of a weaker model).
- complexity: 0 trivial … 1 very hard.`;

const SIDEKICK_INSTRUCTIONS = `You are the Sidekick implementer. Follow the work order exactly; the original user request is authoritative if they differ. Read only what you need, make the changes with the edit/write tools, and run the stated verification. Fix failures yourself before reporting. When one of your own tests fails, first decide from the requirements whether the code or the test expectation is wrong, compute the expected value by hand, and fix the right side; never loop on the same failure. Work efficiently: batch reads, write whole files when rewriting most of them, and run the full verification once after a group of changes. Do not ask questions; make reasonable assumptions and list them.
Finish with a concise report:
## Changes — each file and what changed
## Verification — exact commands and their pass/fail counts (paste the key output lines)
## Assumptions & open issues — anything unverified or uncertain`;

const REVIEW_INSTRUCTIONS = `You are the Lead reviewer and the final authority. The Sidekick's diff below is the ground truth for files it edited; do not re-read those files unless the diff is truncated or you need unchanged surrounding code. Check every numbered requirement and the review focus against the diff. You may run the verification command once if the report lacks convincing evidence. Never modify files in review. Be economical: usually zero to two tool calls are enough; submit as soon as you can judge.
Then call fusion_submit_review once:
- "accept": everything required is done correctly. Put the final user-facing answer in \`answer\` (compact GitHub-flavored Markdown: what changed, verification results, remaining unverified items). Minor style differences are not grounds for revision.
- "revise": list concrete, actionable issues (file, function, the wrong behavior, the expected behavior). They go back to the same Sidekick.
- "takeover": only when the Sidekick already failed to fix the same issue once, or the remaining fix needs subtle reasoning it clearly lacks. Missing or incomplete mechanical work (unwritten tests, an unimplemented function, wrong format) is always "revise": the Sidekick is far cheaper than you.`;

const TAKEOVER_INSTRUCTIONS = `You are the authoritative Lead engineer finishing a task a Sidekick started. The diff and open issues are below; work from them instead of re-reading everything. Fix the listed issues, verify, and finish with the final user-facing answer in compact GitHub-flavored Markdown (what changed, verification, unverified items).`;

function addUsage(total: TokenUsage, usage: TokenUsage): void { total.inputTokens += usage.inputTokens; total.outputTokens += usage.outputTokens; }
function parseJson(text: string): unknown { try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return undefined; } }

export class FusionDelegateEngine {
	constructor(private readonly options: DelegateEngineOptions) {}
	async *stream(request: DelegateRunRequest): AsyncGenerator<FusionEvent> {
		const queue: FusionEvent[] = []; let wake: (() => void) | undefined; let done = false;
		const emit = (event: FusionEvent) => { queue.push(event); wake?.(); };
		const finished = this.run(request, emit).catch(() => undefined).finally(() => { done = true; wake?.(); });
		while (true) {
			if (queue.length) { yield queue.shift()!; continue; }
			if (done) break;
			await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
		}
		await finished;
	}
	private context(session: SessionRecord, role: "main" | "sidekick"): FusionMessage[] {
		const limit = this.options.contextMessageLimit ?? 24;
		return session.contexts[role].slice(-limit);
	}
	private async run(request: DelegateRunRequest, emit: (event: FusionEvent) => void): Promise<void> {
		const { store, models } = this.options;
		const session = request.sessionId ? await store.get(request.sessionId) : await store.create({ prompt: request.prompt });
		if (!session) throw new Error(`Session ${request.sessionId} was not found`);
		if (!request.sessionId) for (const role of ["main", "sidekick"] as const)
			for (const message of request.messages ?? []) await store.append(session.id, role, message);
		const record = (await store.get(session.id))!;
		const id = session.id;
		const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
		const extra = this.options.instructions ? `\n\n${this.options.instructions}` : "";
		const signal = request.signal;
		const sidekick: PiFusionActorHandle = {};
		const tracker = new FusionChangeTracker(this.options.cwd);
		const toolEmitter = (role: "main" | "sidekick", task: string, workerId?: string) => (event: ToolActivityEvent) => {
			if (role === "sidekick") tracker.observe(event);
			const type = event.type === "started" ? "tool.started" : event.type === "completed" ? "tool.completed" : "tool.failed";
			emit({ ...event, type, sessionId: id, role, task, ...(workerId ? { workerId } : {}) } as FusionEvent);
		};
		const streamTo = (role: "main" | "sidekick", task: string, workerId?: string) => (part: { type: "reasoning-delta" | "text-delta"; text: string }) =>
			emit({ type: part.type === "reasoning-delta" ? "task.reasoning.delta" : "task.output.delta", sessionId: id, role, task, delta: part.text, ...(workerId ? { workerId } : {}) });
		try {
			emit({ type: "session.started", sessionId: id, models });
			// 1. Lead brief: one short, tool-less call.
			const briefStage = await this.options.run({ kind: "review", role: "main", model: models.main, signal, maxSteps: 1, activeTools: [],
				submitTool: { name: "fusion_submit_brief", description: "Submit the routing decision and the Sidekick work order.", parameters: DELEGATE_BRIEF_SCHEMA },
				messages: [...this.context(record, "main"), { role: "user", content: `User request:\n${request.prompt}` }], instructions: BRIEF_INSTRUCTIONS + extra });
			addUsage(usage, briefStage.usage);
			const brief = (briefStage.submitted ?? parseJson(briefStage.text)) as Brief | undefined;
			const route = brief?.route === "lead" || !brief?.brief ? "lead" : "delegate";
			emit({ type: "plan.completed", sessionId: id, plan: { complexity: brief?.complexity ?? 1,
				mainTask: route === "lead" ? request.prompt : "Lead: brief, review the Sidekick diff and accept", sidekickTasks: route === "lead" ? [] : [brief!.brief] } });
			let final: string;
			if (route === "lead") {
				final = await this.leadExecute(id, request.prompt, request.prompt, usage, emit, toolEmitter, streamTo, signal, extra, this.context(record, "main"));
			} else {
				final = await this.delegate(id, request.prompt, brief!, record, usage, emit, sidekick, tracker, toolEmitter, streamTo, signal, extra);
			}
			for (const role of ["main", "sidekick"] as const) {
				await store.append(id, role, { role: "user", content: request.prompt });
				await store.append(id, role, { role: "assistant", content: final });
			}
			const total: FusionUsage = { ...usage, totalTokens: usage.inputTokens + usage.outputTokens };
			emit({ type: "session.completed", sessionId: id, text: final, usage: total });
		} catch (error) {
			emit({ type: "session.failed", sessionId: id, message: error instanceof Error ? error.message : String(error) });
		} finally {
			this.options.release(sidekick);
		}
	}
	private async leadExecute(id: string, task: string, content: string, usage: TokenUsage, emit: (event: FusionEvent) => void,
		toolEmitter: (role: "main" | "sidekick", task: string) => (event: ToolActivityEvent) => void,
		streamTo: (role: "main" | "sidekick", task: string) => (part: { type: "reasoning-delta" | "text-delta"; text: string }) => void,
		signal: AbortSignal | undefined, extra: string, context: FusionMessage[], instructions = "You are the authoritative coding agent. Make careful, integrated changes and verify them.", maxSteps?: number): Promise<string> {
		emit({ type: "task.started", sessionId: id, role: "main", task, model: this.options.models.main });
		const result = await this.options.run({ kind: "execute", role: "main", model: this.options.models.main, signal,
			...(maxSteps ? { maxSteps, finalStepTools: [] } : {}), messages: [...context, { role: "user", content }], instructions: instructions + extra,
			onToolEvent: toolEmitter("main", task), onStreamPart: streamTo("main", task) });
		addUsage(usage, result.usage);
		emit({ type: "task.completed", sessionId: id, role: "main", task, text: result.text });
		return result.text;
	}
	private async delegate(id: string, prompt: string, brief: Brief, record: SessionRecord, usage: TokenUsage, emit: (event: FusionEvent) => void,
		sidekick: PiFusionActorHandle, tracker: FusionChangeTracker,
		toolEmitter: (role: "main" | "sidekick", task: string, workerId?: string) => (event: ToolActivityEvent) => void,
		streamTo: (role: "main" | "sidekick", task: string, workerId?: string) => (part: { type: "reasoning-delta" | "text-delta"; text: string }) => void,
		signal: AbortSignal | undefined, extra: string): Promise<string> {
		const { models } = this.options;
		const maxRevisions = this.options.maxRevisions ?? 3;
		const workerId = `${id}:sidekick:delegate`;
		let report = ""; let sidekickError: string | undefined;
		const runSidekick = async (task: string, content: string, first: boolean, steps?: number) => {
			emit({ type: "task.started", sessionId: id, role: "sidekick", task, model: models.sidekick, workerId });
			try {
				const result = await this.options.run({ kind: "execute", role: "sidekick", model: models.sidekick, signal, actor: sidekick, finalStepTools: [],
					maxSteps: steps ?? (first ? this.options.sidekickSteps ?? 50 : Math.ceil((this.options.sidekickSteps ?? 50) * 0.5)),
					messages: [...(first ? this.context(record, "sidekick") : []), { role: "user", content }], instructions: SIDEKICK_INSTRUCTIONS + extra,
					onToolEvent: toolEmitter("sidekick", task, workerId), onStreamPart: streamTo("sidekick", task, workerId) });
				addUsage(usage, result.usage); report = result.text; sidekickError = undefined;
				emit({ type: "task.completed", sessionId: id, role: "sidekick", task, text: result.text, workerId });
			} catch (error) {
				if (signal?.aborted) throw error;
				sidekickError = error instanceof Error ? error.message : String(error);
				emit({ type: "task.failed", sessionId: id, role: "sidekick", task, message: sidekickError, workerId });
			}
		};
		const items = (brief.workItems ?? []).filter(item => item.trim());
		const order = `Work order from Lead:\n${brief.brief}\n\nOriginal user request (authoritative):\n${prompt}`;
		if (items.length <= 1) await runSidekick(brief.brief, order, true);
		else for (const [index, item] of items.entries()) {
			const last = index === items.length - 1;
			const step = `Work item ${index + 1}/${items.length}: ${item}\n\nDo only this item now${last ? ", then run the full verification and send the final report in the required format." : " and reply with one or two lines of status (no full report yet)."}`;
			await runSidekick(`Item ${index + 1}/${items.length}: ${item}`, index === 0 ? `${order}\n\n${step}` : step, index === 0, last ? undefined : 25);
			if (sidekickError) break;
		}
		let issues: string[] = [];
		for (let round = 0; !sidekickError; round++) {
			const { text: diff, truncated, changedFiles } = tracker.diff();
			const task = round === 0 ? "Lead review" : `Lead review (round ${round + 1})`;
			emit({ type: "task.started", sessionId: id, role: "main", task, model: models.main });
			const reviewStage = await this.options.run({ kind: "review", role: "main", model: models.main, signal, maxSteps: this.options.reviewSteps ?? 5, finalStepTools: [],
				activeTools: REVIEW_TOOLS, submitTool: { name: "fusion_submit_review", description: "Submit the review verdict, issues and (on accept) the final answer.", parameters: DELEGATE_REVIEW_SCHEMA },
				onToolEvent: toolEmitter("main", task), onStreamPart: streamTo("main", task),
				messages: [{ role: "user", content: [
					`User request:\n${prompt}`, `Your work order:\n${brief.brief}`, brief.reviewFocus ? `Your review focus:\n${brief.reviewFocus}` : "",
					issues.length ? `Issues you raised last round:\n${issues.map(issue => `- ${issue}`).join("\n")}` : "",
					`Sidekick report:\n${report || "(empty)"}`,
					`Changed files: ${changedFiles.join(", ") || "none tracked"}${tracker.shellUsed ? " (the Sidekick also ran shell commands; shell-made file changes are not in the diff)" : ""}${truncated ? " — diff truncated" : ""}`,
					`Diff:\n${diff || "(no tracked file changes)"}`,
				].filter(Boolean).join("\n\n") }], instructions: REVIEW_INSTRUCTIONS + extra });
			addUsage(usage, reviewStage.usage);
			const review = (reviewStage.submitted ?? parseJson(reviewStage.text)) as Review | undefined;
			emit({ type: "task.completed", sessionId: id, role: "main", task, text: review ? `${review.verdict}${review.issues.length ? `: ${review.issues.join("; ")}` : ""}` : reviewStage.text });
			if (!review) {
				// No structured verdict: treat a substantive text reply as the accepted answer.
				if (reviewStage.text.trim()) { await this.options.appendFinal(reviewStage.text); return reviewStage.text; }
				issues = ["Lead review produced no verdict"]; break;
			}
			if (review.verdict === "accept") {
				const answer = review.answer.trim() || reviewStage.text.trim() || report;
				await this.options.appendFinal(answer);
				return answer;
			}
			issues = review.issues.length ? review.issues : ["Review rejected the change without details"];
			if (review.verdict === "takeover" || round >= maxRevisions) break;
			await runSidekick(`Fix review issues (round ${round + 1})`, `Lead review found these problems. Fix all of them, re-run verification, and send an updated report in the same format.\n${issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}`, false);
		}
		// 3. Takeover: Lead finishes from the diff instead of from scratch.
		const { text: diff } = tracker.diff();
		return this.leadExecute(id, "Lead takeover", [
			`User request:\n${prompt}`, `Work order:\n${brief.brief}`,
			sidekickError ? `The Sidekick failed: ${sidekickError}` : `Open issues:\n${issues.map(issue => `- ${issue}`).join("\n")}`,
			report ? `Last Sidekick report:\n${report}` : "", `Current diff:\n${diff || "(no tracked changes)"}`,
		].filter(Boolean).join("\n\n"), usage, emit, toolEmitter, streamTo, signal, extra, [], TAKEOVER_INSTRUCTIONS, this.options.takeoverSteps ?? 20);
	}
}
