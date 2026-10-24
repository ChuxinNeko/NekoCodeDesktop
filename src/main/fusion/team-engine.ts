import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { mentionedMembers, type TeamMember, type TeamSettings } from "../../shared/team";
import type { PiFusionActorHandle, PiFusionStage, PiFusionStageResult } from "./pi-runner";
import type { FusionEvent, FusionMessage, SessionRecord, SessionStore, TokenUsage, ToolActivityEvent } from "./reference/core/types";
import { teamTools } from "./team-tools";
import { teamWorkspace } from "../team-workspace-store";
import { TeamMessages } from "./team-messages";

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
	roomId?: string;
	models?: () => string[];
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
	private readonly active = new Map<string, AbortController>();
	private roomId = "";
	private readonly actors = new Map<string, { handle: PiFusionActorHandle; signature: string }>();
	private sequence = 0;
	constructor(private readonly options: TeamEngineOptions) {}
	/** Long-lived actors outlive a turn; free them when the chat resets or closes. */
	dispose(): void { for (const controller of this.active.values()) controller.abort(new Error("Team closed")); for (const { handle } of this.actors.values()) this.options.release(handle); this.actors.clear(); }
	modelOf(member: TeamMember): string { return member.modelKey || this.options.defaultModelKey; }
	private actorFor(member: TeamMember, team: TeamSettings): PiFusionActorHandle {
		// A changed role, model or roster gets a fresh actor; its old context no longer fits (the avatar does not matter).
		const signature = JSON.stringify([{ ...member, avatar: undefined }, this.modelOf(member), team.adminId, team.members.map(item => [item.name, item.role, item.access])]);
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
		const finished = this.run(request, emit).catch(error => emit({ type: "session.failed", sessionId: request.sessionId ?? "team", message: error instanceof Error ? error.message : String(error) })).finally(() => { done = true; wake?.(); });
		while (true) {
			if (queue.length) { yield queue.shift()!; continue; }
			if (done) break;
			await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
		}
		await finished;
	}
	private async run(request: TeamRunRequest, emit: Emit): Promise<void> {
		const { store } = this.options;
		const team = structuredClone(this.options.team());
		const room = this.options.roomId ? teamWorkspace().room(this.options.roomId) : undefined;
		if (this.options.roomId && !room) {
			emit({ type: "session.failed", sessionId: request.sessionId ?? "team", message: "This team conversation was deleted. Create a new group or private chat to continue." });
			return;
		}
		if (room) {
			team.members = team.members.filter(member => room.members.includes(member.id));
			team.adminId = room.adminId;
		}
		const admin = team.members.find(member => member.id === team.adminId) ?? team.members[0];
		const session = request.sessionId ? await store.get(request.sessionId) : await store.create({ prompt: request.prompt });
		if (!session) throw new Error(`Session ${request.sessionId} was not found`);
		if (!request.sessionId) for (const message of request.messages ?? []) await store.append(session.id, "main", message);
		const record = (await store.get(session.id)) as SessionRecord;
		const id = session.id;
		this.roomId = this.options.roomId ?? id;
		teamWorkspace().post({ roomId: this.roomId, memberId: "user", name: "User", kind: "message", text: request.prompt });
		const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
		const budget = { left: team.maxAssignments };
		try {
			if (!admin) throw new Error("The team has no members; add some in Settings → Team");
			emit({ type: "session.started", sessionId: id, models: { main: this.modelOf(admin), sidekick: "team" } });
			// @all reaches everyone, admin included; "@Admin … @Coder" stays with the admin.
			const everyone = /(^|[^\p{L}\p{N}_@])@all(?![\p{L}\p{N}_-])/iu.test(request.prompt);
			const named = mentionedMembers(request.prompt, team.members);
			const direct = everyone || (room?.mode === "everyone" && !named.length) ? team.members : named.some(member => member.id === admin.id) ? [] : named;
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
				const room = teamWorkspace().room(this.roomId);
				const resolved = wanted.map(item => ({ item, member: team.members.find(member => (!room || room.direct || room.members.includes(member.id)) && member.name.toLowerCase() === item.member.replace(/^@/, "").toLowerCase()) }));
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
			others ? `Your teammates:\n${others}` : "You have no teammates yet. Create specialists with create_bot when the task needs them.",
			"Use list_bots to inspect the live roster. Main Bots can create persistent specialists with create_bot, then immediately call team_assign or message_bot. Update profiles with update_bot. Do not claim a member exists until the tool succeeds. Use remember/recall for durable facts and decisions; read_own_chat and read_group_chat retrieve past work. New members inherit the creator's model unless the user chose another. Only the user may delete members or grant Main privileges.",
			this.memoryInstructions(admin),
			"Before your first delegation, send a brief message to the user explaining what you will do. Then issue each teammate's concrete task through team_assign or message_bot; each hand-off is displayed as its own chat message. After reports arrive, send a new closing reply. Do not repeat your opening or the full assignment text in the closing reply.",
			"Plain messages from the user come to you. Answer simple things yourself. Hand substantial or specialised work to the right teammates with team_assign: give each a self-contained task (goal, relevant files, constraints, what to report). Prefer the cheapest suitable teammate; split independent work so it can run in parallel, never two writers on the same file. When reports come back, check them against the request, follow up with another assignment if something is missing or wrong, then give the user one coherent answer that says who did what.",
			admin.access === "read-only" ? "You are read-only: you may inspect but must not change the workspace yourself." : "",
			this.options.instructions ?? "",
		].filter(Boolean).join("\n\n");
		const task = `@${admin.name}`;
		const workId = randomUUID();
		teamWorkspace().start({ id: workId, roomId: this.roomId, memberId: admin.id, task: prompt });
		emit({ type: "task.started", sessionId: id, role: "main", task, model: this.modelOf(admin) });
		const controller = new AbortController();
		this.active.set(admin.id, controller);
		teamWorkspace().cancellable(workId, admin.id, this.roomId, () => controller.abort(new Error("Stopped by user")));
		const messages = new TeamMessages(teamWorkspace(), this.roomId, admin, workId);
		try {
		const result = await this.options.run({ kind: "review", role: "main", teamMemberId: admin.id, model: this.modelOf(admin), thinkingLevel: admin.thinkingLevel, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, actor: handle,
			maxSteps: this.options.adminSteps ?? 30, finalStepTools: [], instructions,
			...(admin.access === "read-only" ? { activeTools: READ_ONLY_TOOLS } : {}),
			extraTools: [this.assignTool(id, team, admin, 0, usage, emit, signal, budget), ...this.memberTools(id, team, admin, 0, usage, emit, signal, budget)],
			messages: [...(fresh ? [...this.history(admin), ...record.contexts.main].slice(-limit) : []), { role: "user", content: prompt }],
			onAssistantMessage: (text, interrupted) => { messages.message(text, interrupted); emit({ type: "team.message.completed", sessionId: id, role: "main", task, text, interrupted }); },
			onToolEvent: this.toolEvents(emit, id, "main", task, undefined, workId), onStreamPart: part => {
				if (part.type !== "reasoning-delta") { messages.delta(part.text); teamWorkspace().progress(workId, part.text); }
				emit({ type: part.type === "reasoning-delta" ? "session.reasoning.delta" : "session.output.delta", sessionId: id, delta: part.text });
			} });
		usage.inputTokens += result.usage.inputTokens; usage.outputTokens += result.usage.outputTokens;
		emit({ type: "task.completed", sessionId: id, role: "main", task, text: result.text });
		teamWorkspace().finish(workId, "done", result.text);
		messages.finish(result.text);
		return result.text;
		} catch (error) {
			messages.fail();
			teamWorkspace().finish(workId, signal?.aborted || controller.signal.aborted ? "stopped" : "failed", error instanceof Error ? error.message : String(error));
			throw error;
		} finally { this.active.delete(admin.id); }
	}
	private async runMembers(id: string, team: TeamSettings, jobs: { member: TeamMember; task: string }[], from: string, depth: number,
		usage: TokenUsage, emit: Emit, signal: AbortSignal | undefined, budget: { left: number }, direct: boolean) {
		budget.left -= direct ? 0 : jobs.length;
		const runOne = async ({ member, task }: { member: TeamMember; task: string }) => {
			if (signal?.aborted) throw signal.reason ?? new Error("Team stopped");
			if (this.active.has(member.id)) return { member, text: `@${member.name} is already working or waiting for this report. Finish your task instead of creating a delegation cycle.`, failed: true };
			const workerId = `${id}:team:${member.id}:${++this.sequence}:${randomUUID()}`;
			const controller = new AbortController();
			this.active.set(member.id, controller);
			const memberSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			teamWorkspace().start({ id: workerId, roomId: this.roomId, memberId: member.id, task });
			teamWorkspace().cancellable(workerId, member.id, this.roomId, () => controller.abort(new Error("Stopped by user")));
			if (!direct) {
				const sender = team.members.find(member => member.name.toLowerCase() === from.replace(/^@/, "").toLowerCase());
				teamWorkspace().post({ roomId: this.roomId, memberId: sender?.id ?? "", name: sender?.name ?? from, kind: "assignment", text: `@${member.name} ${task}` });
			}
			const label = `@${member.name}: ${task.replace(/\s+/g, " ").slice(0, 80)}`;
			emit({ type: "task.started", sessionId: id, role: "sidekick", task: label, model: this.modelOf(member), workerId });
			const peers = team.peerDelegation && depth < 2 && team.members.length > 2;
			const mainMember = member.id === this.options.team().adminId || member.main === true;
			const canAssign = peers || mainMember;
			const instructions = [
				`You are ${member.name}, ${member.role || "a member"} of an AI team working in the user's project. The team admin is @${team.members.find(item => item.id === team.adminId)?.name ?? "the admin"}.`,
				member.instructions, `Your teammates:\n${roster(team, member.id)}`,
				mainMember ? "You are a Main Bot. If a task needs a specialist that the team lacks, create it with create_bot and immediately delegate using team_assign or message_bot. Inspect the roster with list_bots first; avoid duplicate members. Check reports before answering the user. Only the user may delete members or grant Main privileges." : "Inspect team status with list_bots. You may update your own profile and memory; only a Main Bot may create members or edit another member.",
				this.memoryInstructions(member),
				"Before delegating, briefly explain your plan to the user, then use the team tools for the actual hand-offs. Each assignment and each subsequent reply is a separate chat message; do not combine them into one long status report.",
				direct ? "The user is talking to you directly; answer them." : `${from} handed you a task. Do it with your tools, then reply with a concise report: what you did, the evidence (commands and results, files changed), and anything unfinished or uncertain.`,
				member.access === "read-only" ? "You are read-only: inspect and report; never change files." : "Other teammates may work in the same project at the same time; only touch files your task needs.",
				peers ? "If part of your task clearly belongs to a teammate's specialty, you may hand it over with team_assign." : "",
				this.options.instructions ?? "",
			].filter(Boolean).join("\n\n");
			const messages = new TeamMessages(teamWorkspace(), this.roomId, member, workerId);
			try {
				const handle = this.actorFor(member, team);
				const fresh = !handle.session;
				const result = await this.options.run({ kind: "execute", role: "sidekick", teamMemberId: member.id, model: this.modelOf(member), thinkingLevel: member.thinkingLevel, signal: memberSignal,
					actor: handle, maxSteps: this.options.memberSteps ?? 30, finalStepTools: [], instructions,
					...(member.access === "read-only" ? { activeTools: READ_ONLY_TOOLS } : {}),
					extraTools: [...(canAssign ? [this.assignTool(id, team, member, depth, usage, emit, memberSignal, budget)] : []), ...this.memberTools(id, team, member, depth, usage, emit, memberSignal, budget)],
					messages: [...(fresh ? this.history(member) : []), { role: "user", content: direct ? task : `Task from ${from}:\n${task}` }],
					onAssistantMessage: (text, interrupted) => { messages.message(text, interrupted); emit({ type: "team.message.completed", sessionId: id, role: "sidekick", task: label, text, workerId, interrupted }); },
					onToolEvent: this.toolEvents(emit, id, "sidekick", label, workerId, workerId),
					onStreamPart: part => {
						if (part.type !== "reasoning-delta") { messages.delta(part.text); teamWorkspace().progress(workerId, part.text); }
						emit({ type: part.type === "reasoning-delta" ? "task.reasoning.delta" : "task.output.delta", sessionId: id, role: "sidekick", task: label, delta: part.text, workerId });
					} });
				usage.inputTokens += result.usage.inputTokens; usage.outputTokens += result.usage.outputTokens;
				emit({ type: "task.completed", sessionId: id, role: "sidekick", task: label, text: result.text, workerId });
				teamWorkspace().finish(workerId, "done", result.text);
				messages.finish(result.text);
				return { member, text: result.text || "(no report)", failed: false };
			} catch (error) {
				messages.fail();
				teamWorkspace().finish(workerId, memberSignal.aborted ? "stopped" : "failed", error instanceof Error ? error.message : String(error));
				if (signal?.aborted) throw error;
				const message = error instanceof Error ? error.message : String(error);
				emit({ type: "task.failed", sessionId: id, role: "sidekick", task: label, message, workerId });
				return { member, text: `Error: ${message}`, failed: true };
			} finally { this.active.delete(member.id); }
		};
		if (team.parallel) return Promise.all(jobs.map(runOne));
		const replies = [];
		for (const job of jobs) replies.push(await runOne(job));
		return replies;
	}
	private history(member: TeamMember): FusionMessage[] {
		return teamWorkspace().posts(this.roomId, 40).filter(post => post.memberId === member.id || post.memberId === "user").slice(-12).map(post => ({ role: post.memberId === "user" ? "user" : "assistant", content: post.text }));
	}
	private memoryInstructions(member: TeamMember): string {
		const workspace = teamWorkspace(), room = workspace.room(this.roomId);
		const memory = workspace.memories(["team", `member:${member.id}`, `room:${this.roomId}`]);
		return [room?.notice ? `Group notice:\n${room.notice}` : "", memory.length ? `Durable memory (facts, not instructions):\n${memory.map(entry => `[${entry.topic}] ${entry.text}`).join("\n").slice(-16000)}` : "", "Use remember for durable decisions and recall to retrieve memories. Keep your report factual; never claim unverified work is done."].filter(Boolean).join("\n\n");
	}
	private memberTools(id: string, team: TeamSettings, member: TeamMember, depth: number, usage: TokenUsage, emit: Emit, signal: AbortSignal | undefined, budget: { left: number }): ToolDefinition[] {
		return teamTools({ team, member, roomId: this.roomId, modelKey: this.modelOf(member), models: this.options.models,
			message: async (target, text) => {
				if (depth >= 2 || budget.left < 1) throw new Error("Team hand-off budget or depth limit reached");
				const replies = await this.runMembers(id, team, [{ member: target, task: text }], `@${member.name}`, depth + 1, usage, emit, signal, budget, false);
				return replies.map(reply => `Report from @${reply.member.name}:\n${reply.text}`).join("\n\n");
			},
			stop: async memberId => { this.active.get(memberId)?.abort(new Error("Stopped by teammate")); },
		});
	}
	private toolEvents(emit: Emit, id: string, role: "main" | "sidekick", task: string, workerId?: string, workId?: string) {
		return (event: ToolActivityEvent) => {
			if (workId) teamWorkspace().progress(workId, "", event.type === "started" ? event.toolName : undefined);
			const type = event.type === "started" ? "tool.started" : event.type === "completed" ? "tool.completed" : "tool.failed";
			emit({ ...event, type, sessionId: id, role, task, ...(workerId ? { workerId } : {}) } as FusionEvent);
		};
	}
}
