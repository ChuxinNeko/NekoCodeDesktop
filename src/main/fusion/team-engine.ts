import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mentionedMembers, type TeamMember, type TeamSettings } from "../../shared/team";
import type { PiFusionActorHandle, PiFusionStage, PiFusionStageResult } from "./pi-runner";
import type { FusionEvent, FusionMessage, SessionRecord, SessionStore, TokenUsage, ToolActivityEvent } from "./reference/core/types";

/**
 * AI team, adapted from DS Bot's admin-moderated group chat
 * (https://github.com/Fei2411/DeepSeek-Bot, Apache-2.0) for NekoCode's engine actors:
 * plain messages go to the admin, which answers or hands work to members with
 * team_assign; `@Name` in the user's message reaches members directly. Every member
 * is a long-lived actor that keeps its own context across the chat's turns.
 */
export const TEAM_ASSIGN_SCHEMA = Type.Object({
	assignments: Type.Array(Type.Object({
		member: Type.String({ minLength: 1, description: "Teammate name, without @" }),
		task: Type.String({ minLength: 1, description: "Self-contained task: goal, relevant files, constraints, what to report back" }),
	}), { minItems: 1, maxItems: 6 }),
});
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

export interface TeamEngineOptions {
	run(stage: PiFusionStage): Promise<PiFusionStageResult>;
	release(handle: PiFusionActorHandle): void;
	appendFinal(text: string, modelKey: string): Promise<void>;
	store: SessionStore;
	team(): TeamSettings;
	/** The chat's model, used by members whose modelKey is empty. */
	defaultModelKey: string;
	instructions?: string;
	contextMessageLimit?: number;
	memberSteps?: number;
	adminSteps?: number;
}
export interface TeamRunRequest { prompt: string; signal?: AbortSignal; sessionId?: string; messages?: FusionMessage[] }

type Emit = (event: FusionEvent) => void;
const roster = (team: TeamSettings, except?: string) => team.members.filter(member => member.id !== except).map(member =>
	`- @${member.name} — ${member.role || "Member"}${member.access === "read-only" ? " (read-only)" : ""}: ${member.instructions.split("\n", 1)[0].slice(0, 160)}`).join("\n");

export class FusionTeamEngine {
	private readonly actors = new Map<string, { handle: PiFusionActorHandle; signature: string }>();
	private sequence = 0;
	constructor(private readonly options: TeamEngineOptions) {}
	/** Long-lived actors outlive a turn; free them when the chat resets or closes. */
	dispose(): void { for (const { handle } of this.actors.values()) this.options.release(handle); this.actors.clear(); }
	modelOf(member: TeamMember): string { return member.modelKey || this.options.defaultModelKey; }
	private actorFor(member: TeamMember, team: TeamSettings): PiFusionActorHandle {
		// A changed role, model or roster gets a fresh actor; its old context no longer fits.
		const signature = JSON.stringify([member, this.modelOf(member), team.adminId, team.members.map(item => [item.name, item.role, item.access])]);
		const known = this.actors.get(member.id);
		if (known?.signature === signature) return known.handle;
		if (known) this.options.release(known.handle);
		const handle: PiFusionActorHandle = {};
		this.actors.set(member.id, { handle, signature });
		return handle;
	}
	async *stream(request: TeamRunRequest): AsyncGenerator<FusionEvent> {
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
	private async run(request: TeamRunRequest, emit: Emit): Promise<void> {
		const { store } = this.options;
		const team = this.options.team();
		const admin = team.members.find(member => member.id === team.adminId) ?? team.members[0];
		const session = request.sessionId ? await store.get(request.sessionId) : await store.create({ prompt: request.prompt });
		if (!session) throw new Error(`Session ${request.sessionId} was not found`);
		if (!request.sessionId) for (const message of request.messages ?? []) await store.append(session.id, "main", message);
		const record = (await store.get(session.id)) as SessionRecord;
		const id = session.id;
		const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
		const budget = { left: team.maxAssignments };
		try {
			if (!admin) throw new Error("The team has no members; add some in Settings → Team");
			emit({ type: "session.started", sessionId: id, models: { main: this.modelOf(admin), sidekick: "team" } });
			// @all reaches everyone, admin included; "@Admin … @Coder" stays with the admin.
			const everyone = /(^|[^\p{L}\p{N}_@])@all(?![\p{L}\p{N}_-])/iu.test(request.prompt);
			const named = mentionedMembers(request.prompt, team.members);
			const direct = everyone ? team.members : named.some(member => member.id === admin.id) ? [] : named;
			let final: string; let author = admin;
			if (direct.length) {
				// The user called members by name: they answer directly, like @ in a group.
				emit({ type: "plan.completed", sessionId: id, plan: { complexity: 0.5, mainTask: `Direct: ${direct.map(member => "@" + member.name).join(", ")}`, sidekickTasks: [] } });
				const replies = await this.runMembers(id, team, direct.map(member => ({ member, task: request.prompt })), "the user", 0, usage, emit, request.signal, budget, true);
				final = replies.length === 1 ? replies[0].text : replies.map(reply => `**@${reply.member.name}**\n\n${reply.text}`).join("\n\n---\n\n");
				if (direct.length === 1) author = direct[0];
			} else {
				emit({ type: "plan.completed", sessionId: id, plan: { complexity: 0.5, mainTask: `@${admin.name} coordinates`, sidekickTasks: [] } });
				final = await this.runAdmin(id, team, admin, request.prompt, record, usage, emit, request.signal, budget);
			}
			await this.options.appendFinal(final, this.modelOf(author));
			await store.append(id, "main", { role: "user", content: request.prompt });
			await store.append(id, "main", { role: "assistant", content: final });
			emit({ type: "session.completed", sessionId: id, text: final, usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens } });
		} catch (error) {
			emit({ type: "session.failed", sessionId: id, message: error instanceof Error ? error.message : String(error) });
		}
	}
	private assignTool(id: string, team: TeamSettings, from: TeamMember, depth: number, usage: TokenUsage, emit: Emit,
		signal: AbortSignal | undefined, budget: { left: number }): ToolDefinition {
		return { name: "team_assign", label: "Team", parameters: TEAM_ASSIGN_SCHEMA,
			description: `Hand work to teammates. Several assignments in one call run ${team.parallel ? "at the same time (give them disjoint files)" : "one after another"}; you get each teammate's report back. ${budget.left} hand-offs left for this message.`,
			execute: async (_toolCallId, args) => {
				const wanted = (args as { assignments: { member: string; task: string }[] }).assignments;
				const resolved = wanted.map(item => ({ item, member: team.members.find(member => member.name.toLowerCase() === item.member.replace(/^@/, "").toLowerCase()) }));
				const problems = resolved.flatMap(({ item, member }) => !member ? [`Unknown teammate "${item.member}". Team:\n${roster(team)}`] :
					member.id === from.id ? ["You cannot assign work to yourself."] : depth > 0 && member.id === team.adminId ? [`@${member.name} is the admin; report back instead.`] : []);
				if (problems.length) return { content: [{ type: "text", text: problems.join("\n") }], details: { error: true } };
				if (resolved.length > budget.left) return { content: [{ type: "text", text: `Only ${budget.left} hand-offs are left for this message; do the rest yourself or assign fewer.` }], details: { error: true } };
				const replies = await this.runMembers(id, team, resolved.map(({ item, member }) => ({ member: member!, task: item.task })), `@${from.name}`, depth + 1, usage, emit, signal, budget, false);
				return { content: [{ type: "text", text: replies.map(reply => `## Report from @${reply.member.name}${reply.failed ? " (failed)" : ""}\n${reply.text}`).join("\n\n") }], details: { members: replies.map(reply => reply.member.name) } };
			} };
	}
	private async runAdmin(id: string, team: TeamSettings, admin: TeamMember, prompt: string, record: SessionRecord, usage: TokenUsage,
		emit: Emit, signal: AbortSignal | undefined, budget: { left: number }): Promise<string> {
		const limit = this.options.contextMessageLimit ?? 24;
		const handle = this.actorFor(admin, team);
		const fresh = !handle.session;
		const others = roster(team, admin.id);
		const instructions = [
			`You are ${admin.name}, ${admin.role || "the lead"} and admin of an AI team working in the user's project.`,
			admin.instructions,
			others ? `Your teammates:\n${others}` : "You have no teammates yet; do the work yourself.",
			"Plain messages from the user come to you. Answer simple things yourself. Hand substantial or specialised work to the right teammates with team_assign: give each a self-contained task (goal, relevant files, constraints, what to report). Prefer the cheapest suitable teammate; split independent work so it can run in parallel, never two writers on the same file. When reports come back, check them against the request, follow up with another assignment if something is missing or wrong, then give the user one coherent answer that says who did what.",
			admin.access === "read-only" ? "You are read-only: you may inspect but must not change the workspace yourself." : "",
			this.options.instructions ?? "",
		].filter(Boolean).join("\n\n");
		const task = `@${admin.name}`;
		emit({ type: "task.started", sessionId: id, role: "main", task, model: this.modelOf(admin) });
		const result = await this.options.run({ kind: "review", role: "main", model: this.modelOf(admin), thinkingLevel: admin.thinkingLevel, signal, actor: handle,
			maxSteps: this.options.adminSteps ?? 30, finalStepTools: [], instructions,
			...(admin.access === "read-only" ? { activeTools: READ_ONLY_TOOLS } : {}),
			extraTools: team.members.length > 1 ? [this.assignTool(id, team, admin, 0, usage, emit, signal, budget)] : [],
			messages: [...(fresh ? record.contexts.main.slice(-limit) : []), { role: "user", content: prompt }],
			onToolEvent: this.toolEvents(emit, id, "main", task), onStreamPart: part => emit({ type: part.type === "reasoning-delta" ? "session.reasoning.delta" : "session.output.delta", sessionId: id, delta: part.text }) });
		usage.inputTokens += result.usage.inputTokens; usage.outputTokens += result.usage.outputTokens;
		emit({ type: "task.completed", sessionId: id, role: "main", task, text: result.text });
		return result.text;
	}
	private async runMembers(id: string, team: TeamSettings, jobs: { member: TeamMember; task: string }[], from: string, depth: number,
		usage: TokenUsage, emit: Emit, signal: AbortSignal | undefined, budget: { left: number }, direct: boolean) {
		budget.left -= direct ? 0 : jobs.length;
		const runOne = async ({ member, task }: { member: TeamMember; task: string }) => {
			const workerId = `${id}:team:${member.id}:${++this.sequence}`;
			const label = `@${member.name}: ${task.replace(/\s+/g, " ").slice(0, 80)}`;
			emit({ type: "task.started", sessionId: id, role: "sidekick", task: label, model: this.modelOf(member), workerId });
			const peers = team.peerDelegation && depth < 2 && team.members.length > 2;
			const instructions = [
				`You are ${member.name}, ${member.role || "a member"} of an AI team working in the user's project. The team admin is @${team.members.find(item => item.id === team.adminId)?.name ?? "the admin"}.`,
				member.instructions, `Your teammates:\n${roster(team, member.id)}`,
				direct ? "The user is talking to you directly; answer them." : `${from} handed you a task. Do it with your tools, then reply with a concise report: what you did, the evidence (commands and results, files changed), and anything unfinished or uncertain.`,
				member.access === "read-only" ? "You are read-only: inspect and report; never change files." : "Other teammates may work in the same project at the same time; only touch files your task needs.",
				peers ? "If part of your task clearly belongs to a teammate's specialty, you may hand it over with team_assign." : "",
				this.options.instructions ?? "",
			].filter(Boolean).join("\n\n");
			try {
				const result = await this.options.run({ kind: "execute", role: "sidekick", model: this.modelOf(member), thinkingLevel: member.thinkingLevel, signal,
					actor: this.actorFor(member, team), maxSteps: this.options.memberSteps ?? 30, finalStepTools: [], instructions,
					...(member.access === "read-only" ? { activeTools: READ_ONLY_TOOLS } : {}),
					...(peers ? { extraTools: [this.assignTool(id, team, member, depth, usage, emit, signal, budget)] } : {}),
					messages: [{ role: "user", content: direct ? task : `Task from ${from}:\n${task}` }],
					onToolEvent: this.toolEvents(emit, id, "sidekick", label, workerId),
					onStreamPart: part => emit({ type: part.type === "reasoning-delta" ? "task.reasoning.delta" : "task.output.delta", sessionId: id, role: "sidekick", task: label, delta: part.text, workerId }) });
				usage.inputTokens += result.usage.inputTokens; usage.outputTokens += result.usage.outputTokens;
				emit({ type: "task.completed", sessionId: id, role: "sidekick", task: label, text: result.text, workerId });
				return { member, text: result.text || "(no report)", failed: false };
			} catch (error) {
				if (signal?.aborted) throw error;
				const message = error instanceof Error ? error.message : String(error);
				emit({ type: "task.failed", sessionId: id, role: "sidekick", task: label, message, workerId });
				return { member, text: `Error: ${message}`, failed: true };
			}
		};
		if (team.parallel) return Promise.all(jobs.map(runOne));
		const replies = [];
		for (const job of jobs) replies.push(await runOne(job));
		return replies;
	}
	private toolEvents(emit: Emit, id: string, role: "main" | "sidekick", task: string, workerId?: string) {
		return (event: ToolActivityEvent) => {
			const type = event.type === "started" ? "tool.started" : event.type === "completed" ? "tool.completed" : "tool.failed";
			emit({ ...event, type, sessionId: id, role, task, ...(workerId ? { workerId } : {}) } as FusionEvent);
		};
	}
}
