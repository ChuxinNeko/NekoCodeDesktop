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
	| { kind: "message"; id: string; member: string; text: string; status: TeamThreadStatus; error?: string; tools: TeamThreadTool[];
		/** Its text is the turn's final answer, which the transcript already shows below. */
		answered?: boolean; model?: string }
	| { kind: "assign"; id: string; member: string; to: string; task: string };

export interface TeamThreadTurn {
	prompt: string;
	status: FusionTurn["status"] | "running";
	items: TeamThreadItem[];
}

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
	if (final !== undefined) {
		const answer = final.trim();
		// The admin's closing words and direct replies are the answer itself; show them once.
		const last = items.at(-1);
		if (last?.kind === "message" && last.member === admin && !last.tools.length && last.text.trim() && answer.includes(last.text.trim())) items.pop();
		else if (last?.kind === "message" && last.member === admin && last.text.trim() && answer.includes(last.text.trim())) last.answered = true;
		if (direct) for (const item of items) if (item.kind === "message" && item.text.trim() && answer.includes(item.text.trim())) item.answered = true;
	}
	return items.filter(item => item.kind === "assign" || item.text.trim() || item.tools.length || item.status !== "done" || item.error);
}

/** Every team turn the engine state still holds, oldest first. */
export function teamThreadTurns(state: FusionState | undefined): TeamThreadTurn[] {
	if (!state) return [];
	const turns: TeamThreadTurn[] = state.history.filter(turn => isTeamRun(turn.events)).map(turn => ({
		prompt: turn.prompt, status: turn.status, items: teamThreadItems(turn.events, turn.status === "complete" ? turn.output : undefined) }));
	if (state.prompt && isTeamRun(state.events)) turns.push({ prompt: state.prompt, status: state.status === "idle" ? "running" : state.status,
		items: teamThreadItems(state.events, state.status === "complete" ? state.output : undefined) });
	return turns;
}
