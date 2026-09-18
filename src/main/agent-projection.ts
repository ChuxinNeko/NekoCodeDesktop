import type { AgentCell, TurnUsage } from "../shared/agent";

// Structural shapes mirroring pi-ai/pi-agent-core messages and events so the
// projection stays pure and testable without importing the agent runtime.

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** The `usage` block pi-ai puts on every assistant message. */
export interface ProjectableUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

export interface ProjectableMessage {
	role: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
	timestamp?: number;
	command?: string;
	output?: string;
	exitCode?: number;
	details?: unknown;
	display?: boolean;
	summary?: string;
	customType?: string;
	usage?: ProjectableUsage;
	provider?: string;
	model?: string;
	responseModel?: string;
}

export type ProjectionEvent =
	| { type: "message_start"; message: ProjectableMessage }
	| { type: "message_update"; message: ProjectableMessage }
	| { type: "message_end"; message: ProjectableMessage }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: unknown;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
	  }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "agent_settled" }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "compaction_start"; reason?: string }
	| { type: "compaction_end"; aborted?: boolean; errorMessage?: string };

export interface SlashCommand {
	command: string;
	args: string;
}

export function parseSlashCommand(text: string): SlashCommand | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const space = trimmed.indexOf(" ");
	if (space === -1) return { command: trimmed.slice(1), args: "" };
	return {
		command: trimmed.slice(1, space),
		args: trimmed.slice(space + 1).trim(),
	};
}

function isTextBlock(block: unknown): block is TextBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "text" &&
		typeof (block as { text?: unknown }).text === "string"
	);
}

function isThinkingBlock(block: unknown): block is ThinkingBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "thinking" &&
		typeof (block as { thinking?: unknown }).thinking === "string"
	);
}

function isToolCallBlock(
	block: unknown,
): block is { type: "toolCall"; id: string; name: string; arguments?: unknown } {
	if (typeof block !== "object" || block === null) return false;
	const b = block as { type?: unknown; id?: unknown; name?: unknown };
	return (
		b.type === "toolCall" &&
		typeof b.id === "string" &&
		typeof b.name === "string"
	);
}

function toolCallArgs(block: { arguments?: unknown }): Record<string, unknown> {
	const args = block.arguments;
	return typeof args === "object" && args !== null
		? (args as Record<string, unknown>)
		: {};
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((b) => b.text)
		.join("");
}

export function thinkingOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(isThinkingBlock)
		.map((b) => b.thinking)
		.join("");
}

/**
 * Has this message stopped reasoning and started producing?
 *
 * Which is what ends a thinking block: the first text or tool call is the
 * moment the model left off thinking, and it lands well before the message
 * itself does.
 */
export function hasNonThinkingContent(content: unknown): boolean {
	return (
		textOf(content).length > 0 ||
		(Array.isArray(content) && content.some(isToolCallBlock))
	);
}

/** Extract displayable text from a tool result/partialResult payload. */
export function toolOutputText(result: unknown): string {
	if (result === null || result === undefined) return "";
	if (typeof result === "string") return result;
	if (typeof result === "object") {
		const content = (result as { content?: unknown }).content;
		const text = textOf(content);
		if (text) return text;
	}
	return "";
}

function toolResultDetails(result: unknown): unknown {
	if (typeof result !== "object" || result === null) return undefined;
	return (result as { details?: unknown }).details;
}

function ts(message: ProjectableMessage): number {
	return typeof message.timestamp === "number" ? message.timestamp : 0;
}

type ToolCell = Extract<AgentCell, { type: "tool" }>;

/** Thinking-block timing observed while the message streamed, by message ts. */
export type ThinkingTiming = Map<number, { startedAt: number; endedAt?: number }>;

/** Start/end of the whole model call, observed live, by message ts. */
export type CallTiming = Map<number, { startedAt: number; endedAt?: number }>;

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function assistantError(message: ProjectableMessage): string | undefined {
	return message.stopReason === "error" || message.stopReason === "aborted"
		? (message.errorMessage ?? message.stopReason)
		: undefined;
}

/** Does this assistant message render a cell at all? Tool-call-only ones do not. */
function showsAssistantCell(message: ProjectableMessage): boolean {
	return Boolean(
		textOf(message.content) || thinkingOf(message.content) || assistantError(message),
	);
}

/**
 * Sum every model call in one turn.
 *
 * Returns undefined when no call in the turn reported tokens — an aborted run,
 * or a provider that does not account for usage. A panel of zeroes there would
 * read as "this turn was free" rather than "nothing was reported".
 */
export function aggregateTurnUsage(
	messages: readonly ProjectableMessage[],
	callTiming?: CallTiming,
): TurnUsage | undefined {
	let calls = 0;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;
	let cost = 0;
	let reasoning: number | undefined;
	let provider = "";
	let model = "";
	let responseModel: string | undefined;
	let modelMs = 0;
	let startedAt: number | undefined;
	let endedAt: number | undefined;

	for (const message of messages) {
		const timing = callTiming?.get(ts(message));
		if (timing?.endedAt !== undefined) {
			modelMs += Math.max(0, timing.endedAt - timing.startedAt);
			startedAt = startedAt === undefined ? timing.startedAt : Math.min(startedAt, timing.startedAt);
			endedAt = endedAt === undefined ? timing.endedAt : Math.max(endedAt, timing.endedAt);
		}
		const usage = message.usage;
		if (!usage) continue;
		const messageInput = num(usage.input);
		const messageOutput = num(usage.output);
		const messageCacheRead = num(usage.cacheRead);
		const messageCacheWrite = num(usage.cacheWrite);
		const messageTotal =
			num(usage.totalTokens) ||
			messageInput + messageOutput + messageCacheRead + messageCacheWrite;
		if (messageTotal === 0) continue;
		calls++;
		input += messageInput;
		output += messageOutput;
		cacheRead += messageCacheRead;
		cacheWrite += messageCacheWrite;
		totalTokens += messageTotal;
		cost += num(usage.cost?.total);
		if (typeof usage.reasoning === "number") reasoning = (reasoning ?? 0) + usage.reasoning;
		// The last call in the turn names the model: mid-turn switches are rare,
		// and the one the answer came from is the useful one to report.
		provider = message.provider ?? provider;
		model = message.model ?? model;
		responseModel =
			message.responseModel && message.responseModel !== message.model
				? message.responseModel
				: responseModel;
	}
	if (calls === 0) return undefined;

	return {
		provider,
		model,
		...(responseModel ? { responseModel } : {}),
		calls,
		input,
		output,
		cacheRead,
		cacheWrite,
		...(reasoning !== undefined ? { reasoning } : {}),
		totalTokens,
		...(cost > 0 ? { costUsd: cost } : {}),
		...(startedAt !== undefined && endedAt !== undefined
			? { durationMs: endedAt - startedAt, modelMs }
			: {}),
	};
}

/**
 * Where each turn's usage goes: the index of the last assistant message that
 * renders a cell in it.
 *
 * The turn still running is skipped — its totals are not final, and attaching a
 * partial sum to an intermediate message would move the panel down the
 * transcript as the turn went on.
 */
function turnUsageByMessage(
	messages: readonly ProjectableMessage[],
	callTiming: CallTiming | undefined,
	running: boolean,
): Map<number, TurnUsage> {
	const turns: { assistants: number[]; lastShown: number | null }[] = [];
	let turn: { assistants: number[]; lastShown: number | null } | null = null;
	messages.forEach((message, index) => {
		if (message.role === "user") {
			turn = { assistants: [], lastShown: null };
			turns.push(turn);
			return;
		}
		if (message.role !== "assistant") return;
		if (!turn) {
			turn = { assistants: [], lastShown: null };
			turns.push(turn);
		}
		turn.assistants.push(index);
		if (showsAssistantCell(message)) turn.lastShown = index;
	});

	const byMessage = new Map<number, TurnUsage>();
	turns.forEach((entry, index) => {
		if (running && index === turns.length - 1) return;
		if (entry.lastShown === null) return;
		const usage = aggregateTurnUsage(
			entry.assistants.map((i) => messages[i]),
			callTiming,
		);
		if (usage) byMessage.set(entry.lastShown, usage);
	});
	return byMessage;
}

/**
 * Rebuild cells for all persisted messages in a session. IDs are stable:
 * derived from message timestamp + array index, or toolCallId for tool cells,
 * so identical input yields identical output.
 *
 * `thinkingTiming` carries the live-observed think start/end onto the persisted
 * cell — history alone has no per-block timestamps, so sessions reopened from
 * disk simply show "Thought" without a duration. `callTiming` does the same for
 * the model calls, which is what the usage panel reports durations from.
 *
 * `running` says a turn is still in flight, so its usage is left off until the
 * agent has stopped and the totals mean something.
 */
export function projectMessages(
	messages: readonly ProjectableMessage[],
	thinkingTiming?: ThinkingTiming,
	callTiming?: CallTiming,
	running = false,
): AgentCell[] {
	const usageByMessage = turnUsageByMessage(messages, callTiming, running);
	const cells: AgentCell[] = [];
	const toolByCallId = new Map<string, ToolCell>();
	let noticeSeq = 0;

	messages.forEach((message, index) => {
		const t = ts(message);
		switch (message.role) {
			case "user": {
				const text = textOf(message.content);
				if (!text.trim()) break;
				cells.push({
					id: `user-${t}-${index}`,
					type: "user",
					text,
					timestamp: t || Date.now(),
				});
				break;
			}
			case "assistant": {
				const text = textOf(message.content);
				const thinking = thinkingOf(message.content);
				const error = assistantError(message);
				if (text || thinking || error) {
					const timing = thinking ? thinkingTiming?.get(t) : undefined;
					cells.push({
						id: `assistant-${t}-${index}`,
						type: "assistant",
						text,
						thinking,
						streaming: false,
						error,
						timestamp: t || Date.now(),
						thinkingStartedAt: timing?.startedAt,
						thinkingEndedAt: timing?.endedAt,
						usage: usageByMessage.get(index),
					});
				}
				// Tool calls inside the assistant content become pending tool cells
				// in stream order; a later toolResult updates them in place.
				if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (!isToolCallBlock(block)) continue;
						const existing = toolByCallId.get(block.id);
						if (existing) {
							if (existing.args === undefined) {
								existing.args = toolCallArgs(block);
							}
							continue;
						}
						const cell: ToolCell = {
							id: `tool-${block.id}`,
							type: "tool",
							toolCallId: block.id,
							toolName: block.name,
							args: toolCallArgs(block),
							output: error ?? "",
							status: error ? "error" : "pending",
							// The message that asked for the call is where the work began.
							startedAt: t || Date.now(),
							timestamp: t || Date.now(),
						};
						toolByCallId.set(block.id, cell);
						cells.push(cell);
					}
				}
				break;
			}
			case "toolResult": {
				const callId = message.toolCallId ?? "";
				const output = textOf(message.content);
				const status = message.isError ? "error" : "done";
				const existing = callId ? toolByCallId.get(callId) : undefined;
				if (existing) {
					// Update in place: keep original position and args.
					existing.toolName = message.toolName ?? existing.toolName;
					existing.output = output;
					existing.details = message.details;
					existing.status = status;
					existing.timestamp = ts(message) || existing.timestamp;
				} else {
					const cell: ToolCell = {
						id: callId ? `tool-${callId}` : `tool-${t}-${index}`,
						type: "tool",
						toolCallId: callId,
						toolName: message.toolName ?? "tool",
						args: undefined,
						output,
						details: message.details,
						status,
						timestamp: t || Date.now(),
					};
					if (callId) toolByCallId.set(callId, cell);
					cells.push(cell);
				}
				break;
			}
			case "bashExecution": {
				cells.push({
					id: `tool-bash-${t}-${index}`,
					type: "tool",
					toolCallId: `bash-${t}-${index}`,
					toolName: "bash",
					args: { command: message.command },
					output: message.output ?? "",
					status: message.exitCode === 0 ? "done" : "error",
					timestamp: t || Date.now(),
				});
				break;
			}
			case "custom": {
				if (message.display === false) break;
				const text = textOf(message.content);
				if (!text.trim()) break;
				cells.push({
					id: `notice-${t}-${index}-${noticeSeq++}`,
					type: "notice",
					level: "info",
					text,
					timestamp: t || Date.now(),
				});
				break;
			}
			case "compactionSummary": {
				cells.push({
					id: `notice-${t}-${index}-${noticeSeq++}`,
					type: "notice",
					level: "info",
					text: "Context compacted",
					timestamp: t || Date.now(),
				});
				break;
			}
			default:
				break;
		}
	});
	return cells;
}

/**
 * Tracks the non-persisted overlay cells for the current run: the in-flight
 * streaming assistant message, live tool executions, and UI notices.
 *
 * Merge rules vs persisted cells:
 * - An overlay tool cell overrides a persisted tool cell with the same
 *   toolCallId while the persisted one is still pending (keeps its position).
 * - Once the persisted cell reaches done/error it wins and the overlay is
 *   dropped on the next rebuild (its args are folded back if needed).
 */
export class CellProjector {
	private persisted: AgentCell[] = [];
	private overlay: AgentCell[] = [];
	private noticeSeq = 0;
	private thinkingTiming: ThinkingTiming = new Map();
	private callTiming: CallTiming = new Map();

	/** `running` is the session's own streaming flag: it spans a whole turn,
	 *  tool calls included, which is exactly the span usage is summed over. */
	rebuild(messages: readonly ProjectableMessage[], running = false): void {
		this.persisted = projectMessages(messages, this.thinkingTiming, this.callTiming, running);
		const persistedTools = new Map<string, ToolCell>();
		for (const c of this.persisted) {
			if (c.type === "tool") persistedTools.set(c.toolCallId, c);
		}
		this.overlay = this.overlay.filter((c) => {
			if (c.type !== "tool") return true;
			const p = persistedTools.get(c.toolCallId);
			if (!p) return true;
			if (p.status === "done" || p.status === "error") {
				if (p.args === undefined && c.args !== undefined) p.args = c.args;
				return false;
			}
			return true;
		});
	}

	handleEvent(event: ProjectionEvent): void {
		switch (event.type) {
			case "message_start":
			case "message_update": {
				if (event.message.role === "assistant") {
					// Wall-clock for the call starts at the first sign of the message
					// and is what the usage panel divides output tokens by.
					const t = ts(event.message);
					if (!this.callTiming.has(t)) this.callTiming.set(t, { startedAt: Date.now() });
					this.upsertStreamCell(event.message);
					this.updateStreamTools(event.message);
				}
				break;
			}
			case "message_end": {
				if (event.message.role === "assistant") {
					const t = ts(event.message);
					const timing = this.thinkingTiming.get(t);
					if (timing && timing.endedAt === undefined) {
						timing.endedAt = Date.now();
					}
					const call = this.callTiming.get(t);
					if (call) call.endedAt ??= Date.now();
					this.dropStreamCell(event.message);
				}
				break;
			}
			case "tool_execution_start": {
				const existing = this.findTool(event.toolCallId);
				if (existing) {
					existing.status = "running";
					existing.inputStreaming = undefined;
					existing.toolName = event.toolName;
					if (event.args !== undefined) existing.args = event.args;
				} else {
					this.overlay.push({
						id: `tool-${event.toolCallId}`,
						type: "tool",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						output: "",
						status: "running",
						startedAt: Date.now(),
						timestamp: Date.now(),
					});
				}
				break;
			}
			case "tool_execution_update": {
				const cell = this.findTool(event.toolCallId);
				if (cell) {
					cell.output = toolOutputText(event.partialResult) || cell.output;
					if (event.args !== undefined) cell.args = event.args;
					const details = toolResultDetails(event.partialResult);
					if (details !== undefined) cell.details = details;
				}
				break;
			}
			case "tool_execution_end": {
				const cell = this.findTool(event.toolCallId);
				if (cell) {
					cell.output = toolOutputText(event.result) || cell.output;
					const details = toolResultDetails(event.result);
					if (details !== undefined) cell.details = details;
					cell.status = event.isError ? "error" : "done";
				}
				break;
			}
			case "agent_end":
			case "agent_settled": {
				const now = Date.now();
				for (const timing of this.thinkingTiming.values()) {
					timing.endedAt ??= now;
				}
				// An aborted call never sees message_end; close it here so its row
				// reports the time it actually ran rather than nothing at all.
				for (const call of this.callTiming.values()) {
					call.endedAt ??= now;
				}
				this.overlay = this.overlay.filter(
					(c) => !(c.type === "assistant" && c.streaming) && !(c.type === "tool" && c.inputStreaming),
				);
				break;
			}
			case "auto_retry_start": {
				this.notice(
					"warning",
					`Retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
				);
				break;
			}
			case "auto_retry_end": {
				if (!event.success) {
					this.notice("error", event.finalError ?? "Retry failed");
				}
				break;
			}
			case "compaction_start": {
				this.notice("info", "Compacting context…");
				break;
			}
			case "compaction_end": {
				if (event.errorMessage) this.notice("error", event.errorMessage);
				break;
			}
			default:
				break;
		}
	}

	notice(level: "info" | "warning" | "error", text: string): void {
		this.overlay.push({
			id: `notice-live-${Date.now().toString(36)}-${(this.noticeSeq++).toString(36)}`,
			type: "notice",
			level,
			text,
			timestamp: Date.now(),
		});
	}

	cells(): AgentCell[] {
		const overlayTools = new Map<string, ToolCell>();
		for (const c of this.overlay) {
			if (c.type === "tool") overlayTools.set(c.toolCallId, c);
		}
		const persistedDone = new Set(
			this.persisted
				.filter(
					(c): c is ToolCell =>
						c.type === "tool" &&
						(c.status === "done" || c.status === "error"),
				)
				.map((c) => c.toolCallId),
		);
		const consumed = new Set<string>();
		const merged = this.persisted.map((c) => {
			if (c.type !== "tool") return c;
			const o = overlayTools.get(c.toolCallId);
			if (!o || c.status === "done" || c.status === "error") return c;
			consumed.add(c.toolCallId);
			return {
				...c,
				args: o.args ?? c.args,
				output: o.output || c.output,
				details: o.details ?? c.details,
				status: o.status,
				inputStreaming: o.inputStreaming,
			};
		});
		const extra = this.overlay.filter(
			(c) =>
				c.type !== "tool" ||
				(!consumed.has(c.toolCallId) && !persistedDone.has(c.toolCallId)),
		);
		return [...merged, ...extra];
	}

	reset(): void {
		this.persisted = [];
		this.overlay = [];
		this.thinkingTiming.clear();
		this.callTiming.clear();
	}

	private upsertStreamCell(message: ProjectableMessage): void {
		const t = ts(message);
		const id = `assistant-stream-${t}`;
		const text = textOf(message.content);
		const thinking = thinkingOf(message.content);
		const error =
			message.stopReason === "error" || message.stopReason === "aborted"
				? (message.errorMessage ?? message.stopReason)
				: undefined;

		// Thinking ends when the first non-thinking block (text or tool call)
		// arrives; if none does, message_end/agent_end stamp it instead.
		let timing = this.thinkingTiming.get(t);
		if (thinking && !timing) {
			timing = { startedAt: Date.now() };
			this.thinkingTiming.set(t, timing);
		}
		if (timing && timing.endedAt === undefined && hasNonThinkingContent(message.content)) {
			timing.endedAt = Date.now();
		}

		const existing = this.overlay.find((c) => c.id === id);
		if (existing && existing.type === "assistant") {
			existing.text = text;
			existing.thinking = thinking;
			existing.error = error;
			existing.thinkingStartedAt = timing?.startedAt;
			existing.thinkingEndedAt = timing?.endedAt;
			return;
		}
		this.overlay.push({
			id,
			type: "assistant",
			text,
			thinking,
			streaming: true,
			error,
			timestamp: t || Date.now(),
			thinkingStartedAt: timing?.startedAt,
			thinkingEndedAt: timing?.endedAt,
		});
	}

	private dropStreamCell(message: ProjectableMessage): void {
		const id = `assistant-stream-${ts(message)}`;
		this.overlay = this.overlay.filter((c) => c.id !== id && !(c.type === "tool" && c.inputStreaming));
	}

	private updateStreamTools(message: ProjectableMessage): void {
		// PI already parses incomplete tool JSON on each provider delta. Project
		// that partial input immediately, before tool_execution_start can fire.
		// Replace only input previews: execution events own running/result cells.
		this.overlay = this.overlay.filter((c) => !(c.type === "tool" && c.inputStreaming));
		if (!Array.isArray(message.content)) return;
		for (const block of message.content) {
			if (!isToolCallBlock(block) || !block.id) continue;
			if (block.name !== "edit" && block.name !== "write") continue;
			if (this.findTool(block.id)) continue;
			this.overlay.push({
				id: `tool-${block.id}`,
				type: "tool",
				toolCallId: block.id,
				toolName: block.name,
				args: toolCallArgs(block),
				output: "",
				status: "pending",
				inputStreaming: true,
				startedAt: ts(message) || Date.now(),
				timestamp: ts(message) || Date.now(),
			});
		}
	}

	private findTool(toolCallId: string): ToolCell | undefined {
		for (let i = this.overlay.length - 1; i >= 0; i--) {
			const cell = this.overlay[i];
			if (cell.type === "tool" && cell.toolCallId === toolCallId) return cell;
		}
		return undefined;
	}
}
