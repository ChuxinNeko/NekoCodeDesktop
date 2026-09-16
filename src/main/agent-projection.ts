import type { AgentCell } from "../shared/agent";

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
	display?: boolean;
	summary?: string;
	customType?: string;
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

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((b) => b.text)
		.join("");
}

function thinkingOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(isThinkingBlock)
		.map((b) => b.thinking)
		.join("");
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

function ts(message: ProjectableMessage): number {
	return typeof message.timestamp === "number" ? message.timestamp : 0;
}

type ToolCell = Extract<AgentCell, { type: "tool" }>;

/**
 * Rebuild cells for all persisted messages in a session. IDs are stable:
 * derived from message timestamp + array index, or toolCallId for tool cells,
 * so identical input yields identical output.
 */
export function projectMessages(messages: readonly ProjectableMessage[]): AgentCell[] {
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
				const error =
					message.stopReason === "error" || message.stopReason === "aborted"
						? (message.errorMessage ?? message.stopReason)
						: undefined;
				if (text || thinking || error) {
					cells.push({
						id: `assistant-${t}-${index}`,
						type: "assistant",
						text,
						thinking,
						streaming: false,
						error,
						timestamp: t || Date.now(),
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
							output: "",
							status: "pending",
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

	rebuild(messages: readonly ProjectableMessage[]): void {
		this.persisted = projectMessages(messages);
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
					this.upsertStreamCell(event.message);
				}
				break;
			}
			case "message_end": {
				if (event.message.role === "assistant") {
					this.dropStreamCell(event.message);
				}
				break;
			}
			case "tool_execution_start": {
				const existing = this.findTool(event.toolCallId);
				if (existing) {
					existing.status = "running";
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
				}
				break;
			}
			case "tool_execution_end": {
				const cell = this.findTool(event.toolCallId);
				if (cell) {
					cell.output = toolOutputText(event.result) || cell.output;
					cell.status = event.isError ? "error" : "done";
				}
				break;
			}
			case "agent_end":
			case "agent_settled": {
				this.overlay = this.overlay.filter(
					(c) => !(c.type === "assistant" && c.streaming),
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
				status: o.status,
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
	}

	private upsertStreamCell(message: ProjectableMessage): void {
		const id = `assistant-stream-${ts(message)}`;
		const text = textOf(message.content);
		const thinking = thinkingOf(message.content);
		const error =
			message.stopReason === "error" || message.stopReason === "aborted"
				? (message.errorMessage ?? message.stopReason)
				: undefined;
		const existing = this.overlay.find((c) => c.id === id);
		if (existing && existing.type === "assistant") {
			existing.text = text;
			existing.thinking = thinking;
			existing.error = error;
			return;
		}
		this.overlay.push({
			id,
			type: "assistant",
			text,
			thinking,
			streaming: true,
			error,
			timestamp: ts(message) || Date.now(),
		});
	}

	private dropStreamCell(message: ProjectableMessage): void {
		const id = `assistant-stream-${ts(message)}`;
		this.overlay = this.overlay.filter((c) => c.id !== id);
	}

	private findTool(toolCallId: string): ToolCell | undefined {
		for (let i = this.overlay.length - 1; i >= 0; i--) {
			const cell = this.overlay[i];
			if (cell.type === "tool" && cell.toolCallId === toolCallId) return cell;
		}
		return undefined;
	}
}
