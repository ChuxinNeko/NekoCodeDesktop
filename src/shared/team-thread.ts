import type { FusionEvent } from "../main/fusion/reference/core/types";
import type { FusionState, FusionTurn } from "./fusion-engine-state";

export type TeamThreadStatus = "running" | "done" | "failed";

export interface TeamThreadTool {
	id: string;
	name: string;
	/** A short hint of what the call touched: a path, a command, a pattern. */
	detail: string;
	status: TeamThreadStatus;
}

/** One chat bubble in the team's group conversation. */
export type TeamThreadItem =
	| { kind: "message"; id: string; member: string; text: string; status: TeamThreadStatus; error?: string; tools: TeamThreadTool[]; model?: string }
	| { kind: "assign"; id: string; member: string; to: string; task: string };

export interface TeamThreadTurn {
	prompt: string;
	/** The user message's timestamp, to find it in the transcript; the prompt text is the fallback. */
	userTimestamp?: number;
	status: FusionTurn["status"] | "running";
	items: TeamThreadItem[];
	/**
	 * Who sends the turn's final answer — the transcript's closing reply, drawn as that bot's message.
	 * `null`: several members answered directly; their bubbles hold the replies, the joined copy is not repeated.
	 */
	final?: { member: string | null; text: string };
}

/** A finished team turn, saved on the session so the group chat survives reopening it. */
export const TEAM_THREAD_ENTRY = "nekocode.team.thread.v1";

/** `@Name` or `@Name: task…` — the labels the team engine gives its tasks. */
export function teamTaskMember(task: string): string {
	return /^@([^\s:]+)/.exec(task)?.[1] ?? task;
}

function toolDetail(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const args = input as Record<string, unknown>;
	for (const key of ["path", "file_path", "command", "pattern", "query", "url"]) {
		const value = args[key];
		if (typeof value === "string" && value) return value.replace(/\s+/g, " ").slice(0, 120);
	}
	return "";
}

function isTeamRun(events: FusionEvent[]): boolean {
	return events.some(event => event.type === "session.started" && event.models.sidekick === "team");
}

/** Projects a team run's event stream into a group chat, in the order things happened. */
export function teamThreadItems(events: FusionEvent[], final?: string): TeamThreadItem[] {
	return projectTeamThread(events, final).items;
}

function projectTeamThread(events: FusionEvent[], final?: string): { items: TeamThreadItem[]; final?: TeamThreadTurn["final"] } {
	const items: TeamThreadItem[] = [];
	const workers = new Map<string, Extract<TeamThreadItem, { kind: "message" }>>();
	let admin = "";
	let adminModel: string | undefined;
	let adminMessage: Extract<TeamThreadItem, { kind: "message" }> | undefined;
	let direct = false;
	let sequence = 0;
	const adminBubble = () => {
		if (!adminMessage) {
			adminMessage = { kind: "message", id: `admin:${++sequence}`, member: admin, text: "", status: "running", tools: [], ...(adminModel ? { model: adminModel } : {}) };
			items.push(adminMessage);
		}
		return adminMessage;
	};
	const owner = (event: FusionEvent) => "workerId" in event && event.workerId ? workers.get(event.workerId) : "role" in event && event.role === "main" ? adminBubble() : undefined;
	for (const event of events) {
		switch (event.type) {
			case "plan.completed":
				direct = event.plan.mainTask.startsWith("Direct:");
				break;
			case "task.started":
				if (event.role === "main") { admin = teamTaskMember(event.task); adminModel = event.model; break; }
				if (!event.workerId) break;
				{
					const item: Extract<TeamThreadItem, { kind: "message" }> = { kind: "message", id: event.workerId, member: teamTaskMember(event.task), text: "", status: "running", tools: [], ...(event.model ? { model: event.model } : {}) };
					workers.set(event.workerId, item); items.push(item);
				}
				break;
			case "session.output.delta":
				adminBubble().text += event.delta;
				break;
			case "task.output.delta": {
				const item = event.workerId ? workers.get(event.workerId) : undefined;
				if (item) item.text += event.delta;
				break;
			}
			case "task.completed": {
				if (event.role === "main") { for (const item of items) if (item.kind === "message" && item.member === admin && item.status === "running") item.status = "done"; break; }
				const item = event.workerId ? workers.get(event.workerId) : undefined;
				if (item) { item.text = event.text || item.text; item.status = "done"; }
				break;
			}
			case "task.failed": {
				const item = event.workerId ? workers.get(event.workerId) : event.role === "main" ? adminMessage : undefined;
				if (item) { item.status = "failed"; item.error = event.message; }
				break;
			}
			case "tool.started": {
				if (event.toolName === "team_assign") {
					const from = event.workerId ? workers.get(event.workerId)?.member ?? "" : admin;
					const wanted = (event.input as { assignments?: { member?: unknown; task?: unknown }[] } | undefined)?.assignments ?? [];
					// Text after a hand-off is a new message, as in a chat.
					if (!event.workerId) adminMessage = undefined;
					wanted.forEach((assignment, index) => {
						if (typeof assignment.member === "string" && typeof assignment.task === "string")
							items.push({ kind: "assign", id: `${event.toolCallId}:${index}`, member: from, to: assignment.member.replace(/^@/, ""), task: assignment.task });
					});
					break;
				}
				owner(event)?.tools.push({ id: event.toolCallId, name: event.toolName, detail: toolDetail(event.input), status: "running" });
				break;
			}
			case "tool.completed":
			case "tool.failed": {
				const tool = owner(event)?.tools.find(candidate => candidate.id === event.toolCallId);
				if (tool) tool.status = event.type === "tool.completed" ? "done" : "failed";
				break;
			}
			case "session.failed":
				for (const item of items) if (item.kind === "message" && item.status === "running") { item.status = "failed"; item.error ??= event.message; }
				break;
			default:
				break;
		}
	}
	let author: TeamThreadTurn["final"];
	if (final !== undefined) {
		const answer = final.trim();
		const said = (item: TeamThreadItem) => item.kind === "message" && !!item.text.trim() && answer.includes(item.text.trim());
		const members = items.filter((item): item is Extract<TeamThreadItem, { kind: "message" }> => item.kind === "message");
		if (!direct) {
			// The admin's closing words are the answer: they move to the final message.
			const last = items.at(-1);
			if (last?.kind === "message" && last.member === admin && said(last)) last.text = "";
			author = { member: admin || null, text: final };
		} else if (members.length === 1) {
			if (said(members[0]!)) members[0]!.text = "";
			author = { member: members[0]!.member, text: final };
		} else author = { member: null, text: final };
	}
	return { items: items.filter(item => item.kind === "assign" || item.text.trim() || item.tools.length || item.status !== "done" || item.error),
		...(author ? { final: author } : {}) };
}

/** One team run as a group chat. */
export function teamThreadTurn(events: FusionEvent[], prompt: string, status: TeamThreadTurn["status"], final?: string, userTimestamp?: number): TeamThreadTurn {
	const projected = projectTeamThread(events, status === "complete" ? final : undefined);
	return { prompt, status, items: projected.items, ...(projected.final ? { final: projected.final } : {}), ...(userTimestamp !== undefined ? { userTimestamp } : {}) };
}

export function isTeamThreadTurn(value: unknown): value is TeamThreadTurn {
	const turn = value as TeamThreadTurn | null;
	return !!turn && typeof turn.prompt === "string" && Array.isArray(turn.items) && ["complete", "failed", "running"].includes(turn.status);
}

/** Every team turn the engine state still holds, oldest first. */
export function teamThreadTurns(state: FusionState | undefined): TeamThreadTurn[] {
	if (!state) return [];
	const turns = state.history.filter(turn => isTeamRun(turn.events)).map(turn => teamThreadTurn(turn.events, turn.prompt, turn.status, turn.output));
	const live = liveTeamThreadTurn(state);
	return live ? [...turns, live] : turns;
}

/** What is saved once a run ends: nothing is still running, so nothing may keep typing after a reload. */
export function settledTeamThreadTurn(turn: TeamThreadTurn): TeamThreadTurn {
	const status = turn.status === "running" ? "failed" : turn.status;
	return { ...turn, status, items: turn.items.map(item => item.kind === "message" && item.status === "running" ? { ...item, status: "failed",
		tools: item.tools.map(tool => tool.status === "running" ? { ...tool, status: "failed" } : tool) } : item) };
}

/**
 * The run in progress (or just finished) in the engine state, when it is a team run.
 * `final`: the answer the engine already put on the transcript, known a moment before the run reports completion.
 */
export function liveTeamThreadTurn(state: FusionState | undefined, userTimestamp?: number, final?: string): TeamThreadTurn | undefined {
	if (!state?.prompt || !isTeamRun(state.events)) return undefined;
	const status = state.status === "idle" ? "running" : state.status;
	const projected = projectTeamThread(state.events, final ?? (status === "complete" ? state.output : undefined));
	return { prompt: state.prompt, status, items: projected.items, ...(projected.final ? { final: projected.final } : {}), ...(userTimestamp !== undefined ? { userTimestamp } : {}) };
}

/**
 * Saved turns plus the live one until it is saved — so the thread and its final message never blink
 * between the answer arriving, the run completing and the entry being written.
 */
export function mergeTeamThreads(saved: readonly TeamThreadTurn[], state: FusionState | undefined, userTimestamp?: number, final?: string): TeamThreadTurn[] {
	const unsaved = userTimestamp !== undefined ? !saved.some(turn => turn.userTimestamp === userTimestamp) : state?.status === "running";
	const live = unsaved ? liveTeamThreadTurn(state, userTimestamp, final) : undefined;
	return live ? [...saved, live] : [...saved];
}
