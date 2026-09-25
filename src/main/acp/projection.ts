/**
 * ACP `session/update` notifications → the transcript cells NekoCode renders.
 *
 * Pure bookkeeping, no I/O: the session feeds updates in and reads cells out.
 * Tool calls are mapped onto the tool names the transcript already knows how to
 * draw (`bash`, `read`, `edit`, `write`, `grep`) so an external agent's work
 * looks like NekoCode's own; anything else falls back to a generic row.
 */
import type { AgentCell, ContextUsage, TurnUsage } from "../../shared/agent";
import type { AcpCommand, AcpConfigOption } from "../../shared/acp";

type ToolCell = Extract<AgentCell, { type: "tool" }>;
type AssistantCell = Extract<AgentCell, { type: "assistant" }>;
type Json = Record<string, unknown>;

/** Past this, a tool's output is cut; the agent's own log still has all of it. */
const MAX_TOOL_OUTPUT = 200_000;

/** Pseudo config ids for agents that only speak the older modes/models API. */
export const MODE_CONFIG_ID = "__mode";
export const MODEL_CONFIG_ID = "__model";

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
	for (let index = items.length - 1; index >= 0; index--) {
		if (predicate(items[index])) return index;
	}
	return -1;
}

function isObject(value: unknown): value is Json {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Text of one ACP content block, or a placeholder for what cannot be shown as text. */
export function contentBlockText(block: unknown): string {
	if (!isObject(block)) return "";
	switch (block.type) {
		case "text":
			return str(block.text) ?? "";
		case "image":
			return "[图片]";
		case "audio":
			return "[音频]";
		case "resource_link":
			return `[${str(block.name) ?? str(block.uri) ?? "resource"}]`;
		case "resource": {
			const resource = isObject(block.resource) ? block.resource : {};
			return str(resource.text) ?? `[${str(resource.uri) ?? "resource"}]`;
		}
		default:
			return "";
	}
}

function truncate(text: string): string {
	return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n…（输出过长，已截断）` : text;
}

function rawOutputText(rawOutput: unknown): string {
	if (rawOutput === undefined || rawOutput === null) return "";
	if (typeof rawOutput === "string") return rawOutput;
	if (isObject(rawOutput)) {
		const known = ["formatted_output", "aggregated_output", "stdout", "output", "result", "stderr"]
			.map((key) => rawOutput[key])
			.filter((value): value is string => typeof value === "string");
		// A command that printed nothing still reports its output field, empty.
		if (known.length > 0) return known.find(Boolean) ?? "";
		// An exit code alone says nothing the status icon doesn't.
		const keys = Object.keys(rawOutput).filter((key) => key !== "exit_code" && key !== "exitCode");
		if (keys.length === 0) return "";
	}
	try {
		return JSON.stringify(rawOutput, null, 2);
	} catch {
		return String(rawOutput);
	}
}

/** The readable part of an MCP `tools/call` result: its text, and a mark per image. */
function mcpResultText(rawOutput: unknown): string {
	const result = isObject(rawOutput) && isObject(rawOutput.result) ? rawOutput.result : rawOutput;
	if (!isObject(result) || !Array.isArray(result.content)) return rawOutputText(rawOutput);
	return result.content
		.filter(isObject)
		.map((item) => (item.type === "text" ? (str(item.text) ?? "") : item.type === "image" ? "[图片]" : ""))
		.filter(Boolean)
		.join("\n");
}

function toolStatus(status: unknown): ToolCell["status"] {
	switch (status) {
		case "in_progress":
			return "running";
		case "completed":
			return "done";
		case "failed":
			return "error";
		default:
			return "pending";
	}
}

/** Everything the agent has said about one tool call, merged across updates. */
type RawToolCall = Json & { toolCallId: string };

function commandOf(rawInput: unknown): string | undefined {
	if (!isObject(rawInput)) return undefined;
	const command = rawInput.command ?? rawInput.cmd;
	if (typeof command === "string") return command;
	if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
		return command.join(" ");
	}
	return undefined;
}

function firstLocation(raw: RawToolCall): string | undefined {
	if (!Array.isArray(raw.locations)) return undefined;
	const first: unknown = raw.locations[0];
	return isObject(first) ? str(first.path) : undefined;
}

export function mapToolCall(raw: RawToolCall): Pick<ToolCell, "toolName" | "args" | "output" | "status"> {
	const content = Array.isArray(raw.content) ? raw.content.filter(isObject) : [];
	const rawInput = raw.rawInput;
	const input = isObject(rawInput) ? rawInput : {};
	const title = str(raw.title) ?? "";
	const status = toolStatus(raw.status);
	const text = content
		.filter((entry) => entry.type === "content")
		.map((entry) => contentBlockText(entry.content))
		.filter(Boolean)
		.join("\n");
	const output = truncate(text || rawOutputText(raw.rawOutput));

	// An MCP tool the agent called — NekoCode's own among them. Codex reports
	// these as `execute` with the server, tool and arguments in `rawInput`.
	if (typeof input.server === "string" && typeof input.tool === "string") {
		return {
			toolName: input.tool,
			args: isObject(input.arguments) ? input.arguments : {},
			output: truncate(text || mcpResultText(raw.rawOutput)),
			status,
		};
	}

	// The agent reasoning about something rather than acting — Codex's automatic
	// approval review, for one. Its input is bookkeeping ids; its text is the point.
	if (raw.kind === "think") {
		const verdict = text.split("\n").find((line) => line.trim())?.trim();
		return { toolName: title || "think", args: verdict ? { summary: verdict } : {}, output, status };
	}

	const diffs = content.filter((entry) => entry.type === "diff");
	if (diffs.length > 0) {
		const path = str(diffs[0].path) ?? firstLocation(raw) ?? "";
		const oldText = diffs[0].oldText;
		if (diffs.length === 1 && (oldText === null || oldText === undefined)) {
			return { toolName: "write", args: { path, content: str(diffs[0].newText) ?? "" }, output, status };
		}
		return {
			toolName: "edit",
			args: {
				path,
				edits: diffs.map((diff) => ({ oldText: str(diff.oldText) ?? "", newText: str(diff.newText) ?? "" })),
			},
			output,
			status,
		};
	}

	switch (raw.kind) {
		case "execute":
			return { toolName: "bash", args: { command: commandOf(rawInput) ?? title }, output, status };
		case "read": {
			const path = firstLocation(raw) ?? str(input.path) ?? str(input.file_path);
			if (path) return { toolName: "read", args: { path }, output, status };
			break;
		}
		case "search": {
			const pattern = str(input.pattern) ?? str(input.query) ?? title;
			return { toolName: "grep", args: { pattern }, output, status };
		}
	}
	return {
		toolName: title || str(raw.kind) || "tool",
		args: rawInput === undefined ? {} : rawInput,
		output,
		status,
	};
}

interface RawConfigOption {
	id: string;
	name: string;
	description?: string;
	type?: string;
	currentValue?: unknown;
	options?: unknown;
}

function flattenOptions(options: unknown): AcpConfigOption["options"] {
	if (!Array.isArray(options)) return [];
	const flat: AcpConfigOption["options"] = [];
	for (const entry of options) {
		if (!isObject(entry)) continue;
		// Grouped options carry their members under `options`.
		if (Array.isArray(entry.options)) {
			flat.push(...flattenOptions(entry.options));
			continue;
		}
		const value = str(entry.value);
		if (value === undefined) continue;
		flat.push({ value, name: str(entry.name) ?? value, ...(str(entry.description) ? { description: str(entry.description) } : {}) });
	}
	return flat;
}

/**
 * The session's live state as the agent reports it. Cells are replaced rather
 * than mutated, so a renderer comparing by identity sees exactly what changed.
 */
export class AcpProjection {
	cells: AgentCell[] = [];
	title = "";
	context: ContextUsage | undefined;
	commands: AcpCommand[] = [];
	private rawConfig: RawConfigOption[] = [];
	private modes: { current: string; available: Array<{ id: string; name: string; description?: string }> } | null = null;
	private models: { current: string; available: Array<{ id: string; name: string; description?: string }> } | null = null;

	private nextCell = 1;
	private readonly messageIds = new Map<string, string>();
	private readonly toolCalls = new Map<string, RawToolCall>();
	private readonly toolCells = new Map<string, string>();
	private planCellId: string | null = null;

	constructor(private readonly now: () => number = Date.now) {}

	private id(prefix: string): string {
		return `${prefix}-${this.nextCell++}`;
	}

	private indexOf(id: string): number {
		for (let index = this.cells.length - 1; index >= 0; index--) {
			if (this.cells[index].id === id) return index;
		}
		return -1;
	}

	private replace(index: number, cell: AgentCell): void {
		this.cells = [...this.cells.slice(0, index), cell, ...this.cells.slice(index + 1)];
	}

	private push(cell: AgentCell): void {
		this.cells = [...this.cells, cell];
	}

	/** The session/new (or load) response: modes, models and config options. */
	applySessionSetup(result: unknown): void {
		if (!isObject(result)) return;
		if (Array.isArray(result.configOptions)) this.setConfigOptions(result.configOptions);
		if (isObject(result.modes)) {
			const available = Array.isArray(result.modes.availableModes) ? result.modes.availableModes.filter(isObject) : [];
			this.modes = {
				current: str(result.modes.currentModeId) ?? "",
				available: available.flatMap((mode) => {
					const id = str(mode.id);
					return id ? [{ id, name: str(mode.name) ?? id, ...(str(mode.description) ? { description: str(mode.description) } : {}) }] : [];
				}),
			};
		}
		if (isObject(result.models)) {
			const available = Array.isArray(result.models.availableModels) ? result.models.availableModels.filter(isObject) : [];
			this.models = {
				current: str(result.models.currentModelId) ?? "",
				available: available.flatMap((model) => {
					const id = str(model.modelId);
					return id ? [{ id, name: str(model.name) ?? id, ...(str(model.description) ? { description: str(model.description) } : {}) }] : [];
				}),
			};
		}
	}

	setConfigOptions(options: unknown[]): void {
		this.rawConfig = options.filter(isObject).flatMap((option) => {
			const id = str(option.id);
			return id ? [{ ...option, id, name: str(option.name) ?? id } as RawConfigOption] : [];
		});
	}

	setCurrentMode(modeId: string): void {
		if (this.modes) this.modes = { ...this.modes, current: modeId };
	}

	setCurrentModel(modelId: string): void {
		if (this.models) this.models = { ...this.models, current: modelId };
	}

	/**
	 * Select settings the user can change. Agents that publish config options
	 * get exactly those; older ones get their modes and models synthesized.
	 */
	configOptions(): AcpConfigOption[] {
		const selects = this.rawConfig
			.filter((option) => (option.type ?? "select") === "select")
			.map((option) => ({
				id: option.id,
				name: option.name,
				...(option.description ? { description: option.description } : {}),
				currentValue: typeof option.currentValue === "string" ? option.currentValue : "",
				options: flattenOptions(option.options),
			}))
			.filter((option) => option.options.length > 0);
		if (selects.length > 0) return selects;
		const synthesized: AcpConfigOption[] = [];
		if (this.modes && this.modes.available.length > 0) {
			synthesized.push({
				id: MODE_CONFIG_ID,
				name: "Mode",
				currentValue: this.modes.current,
				options: this.modes.available.map((mode) => ({ value: mode.id, name: mode.name, ...(mode.description ? { description: mode.description } : {}) })),
			});
		}
		if (this.models && this.models.available.length > 0) {
			synthesized.push({
				id: MODEL_CONFIG_ID,
				name: "Model",
				currentValue: this.models.current,
				options: this.models.available.map((model) => ({ value: model.id, name: model.name, ...(model.description ? { description: model.description } : {}) })),
			});
		}
		return synthesized;
	}

	/** The model the agent is on, for labelling usage. */
	currentModel(): string {
		const option = this.rawConfig.find((entry) => entry.id === "model" || (entry as { category?: unknown }).category === "model");
		if (option && typeof option.currentValue === "string") return option.currentValue;
		return this.models?.current ?? "";
	}

	/** The specific thing a tool call acts on: its command, file, or pattern. */
	toolDetail(toolCallId: string): string | undefined {
		const raw = this.toolCalls.get(toolCallId);
		if (!raw) return undefined;
		const { args } = mapToolCall(raw);
		if (!isObject(args)) return undefined;
		return str(args.command) ?? str(args.path) ?? str(args.pattern);
	}

	addUserPrompt(text: string): void {
		this.planCellId = null;
		this.push({ id: this.id("user"), type: "user", text, timestamp: this.now() });
	}

	addNotice(level: "info" | "warning" | "error", text: string): void {
		this.push({ id: this.id("notice"), type: "notice", level, text, timestamp: this.now() });
	}

	/** Apply one `session/update`. Returns false for updates that change nothing shown. */
	apply(update: unknown): boolean {
		if (!isObject(update)) return false;
		switch (update.sessionUpdate) {
			case "user_message_chunk":
				return this.appendUser(contentBlockText(update.content), str(update.messageId));
			case "agent_message_chunk":
				return this.appendAssistant("text", contentBlockText(update.content), str(update.messageId));
			case "agent_thought_chunk":
				return this.appendAssistant("thinking", contentBlockText(update.content), str(update.messageId));
			case "tool_call":
			case "tool_call_update":
				return this.upsertTool(update);
			case "plan":
				return this.updatePlan(update.entries);
			case "available_commands_update":
				this.commands = (Array.isArray(update.availableCommands) ? update.availableCommands : [])
					.filter(isObject)
					.flatMap((command) => {
						const name = str(command.name);
						if (!name) return [];
						const hint = isObject(command.input) ? str(command.input.hint) : undefined;
						return [{ name, description: str(command.description) ?? "", ...(hint ? { hint } : {}) }];
					});
				return true;
			case "current_mode_update": {
				const modeId = str(update.currentModeId);
				if (modeId) this.setCurrentMode(modeId);
				return true;
			}
			case "config_option_update":
				if (Array.isArray(update.configOptions)) this.setConfigOptions(update.configOptions);
				return true;
			case "session_info_update": {
				const title = str(update.title);
				if (!title) return false;
				this.title = title;
				return true;
			}
			case "usage_update": {
				const used = update.used;
				const size = update.size;
				if (typeof used !== "number" || typeof size !== "number" || size <= 0) return false;
				this.context = { used, window: size };
				return true;
			}
			default:
				return false;
		}
	}

	private appendUser(text: string, messageId: string | undefined): boolean {
		if (!text) return false;
		const last = this.cells.at(-1);
		if (last?.type === "user" && (messageId === undefined || this.messageIds.get(last.id) === messageId)) {
			this.replace(this.cells.length - 1, { ...last, text: last.text + text });
			return true;
		}
		const id = this.id("user");
		if (messageId) this.messageIds.set(id, messageId);
		this.planCellId = null;
		this.push({ id, type: "user", text, timestamp: this.now() });
		return true;
	}

	private appendAssistant(part: "text" | "thinking", text: string, messageId: string | undefined): boolean {
		if (!text) return false;
		const now = this.now();
		const last = this.cells.at(-1);
		if (last?.type === "assistant" && last.streaming) {
			const known = this.messageIds.get(last.id);
			// Thinking and the answer after it arrive as separate messages but read
			// as one reply; a new message only splits once the cell has answer text.
			const continues =
				part === "thinking"
					? !last.text
					: !last.text || messageId === undefined || known === undefined || known === messageId;
			if (continues) {
				if (part === "text" && messageId) this.messageIds.set(last.id, messageId);
				this.replace(
					this.cells.length - 1,
					part === "thinking"
						? { ...last, thinking: last.thinking + text, thinkingStartedAt: last.thinkingStartedAt ?? now }
						: {
								...last,
								text: last.text + text,
								...(last.thinking && last.thinkingEndedAt === undefined ? { thinkingEndedAt: now } : {}),
							},
				);
				return true;
			}
		}
		this.closeAssistant();
		const id = this.id("assistant");
		if (part === "text" && messageId) this.messageIds.set(id, messageId);
		this.push({
			id,
			type: "assistant",
			text: part === "text" ? text : "",
			thinking: part === "thinking" ? text : "",
			streaming: true,
			timestamp: now,
			...(part === "thinking" ? { thinkingStartedAt: now } : {}),
		});
		return true;
	}

	/** Mark the open reply, if any, as finished. */
	private closeAssistant(): void {
		const index = findLastIndex(this.cells, (cell) => cell.type === "assistant" && cell.streaming);
		if (index === -1) return;
		const cell = this.cells[index] as AssistantCell;
		this.replace(index, {
			...cell,
			streaming: false,
			...(cell.thinking && cell.thinkingEndedAt === undefined ? { thinkingEndedAt: this.now() } : {}),
		});
	}

	private upsertTool(update: Json): boolean {
		const toolCallId = str(update.toolCallId);
		if (!toolCallId) return false;
		const { sessionUpdate: _kind, ...fields } = update;
		const merged: RawToolCall = { ...(this.toolCalls.get(toolCallId) ?? {}), ...fields, toolCallId };
		this.toolCalls.set(toolCallId, merged);
		const mapped = mapToolCall(merged);
		const now = this.now();
		const cellId = this.toolCells.get(toolCallId);
		const index = cellId ? this.indexOf(cellId) : -1;
		if (index !== -1) {
			const cell = this.cells[index] as ToolCell;
			const finished = mapped.status === "done" || mapped.status === "error";
			this.replace(index, { ...cell, ...mapped, timestamp: finished ? now : cell.timestamp });
			return true;
		}
		this.closeAssistant();
		const id = this.id("tool");
		this.toolCells.set(toolCallId, id);
		this.push({ id, type: "tool", toolCallId, ...mapped, startedAt: now, timestamp: now });
		return true;
	}

	private updatePlan(entries: unknown): boolean {
		if (!Array.isArray(entries)) return false;
		const lines = entries.filter(isObject).map((entry) => {
			const mark = entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "▸" : "○";
			return `${mark} ${str(entry.content) ?? ""}`;
		});
		const text = `计划\n${lines.join("\n")}`;
		const index = this.planCellId ? this.indexOf(this.planCellId) : -1;
		if (index !== -1) {
			const cell = this.cells[index];
			if (cell.type === "notice") this.replace(index, { ...cell, text });
			return true;
		}
		this.planCellId = this.id("plan");
		this.push({ id: this.planCellId, type: "notice", level: "info", text, timestamp: this.now() });
		return true;
	}

	/**
	 * The prompt request returned: close the reply, settle tools the agent left
	 * open, and hang the turn's usage on its last message.
	 */
	finishTurn(stopReason: string, usage?: Omit<TurnUsage, "provider" | "model">, provider = ""): void {
		this.closeAssistant();
		const cancelled = stopReason === "cancelled";
		this.cells = this.cells.map((cell) =>
			cell.type === "tool" && (cell.status === "pending" || cell.status === "running")
				? { ...cell, status: cancelled ? "error" : "done" }
				: cell,
		);
		if (usage) {
			const index = findLastIndex(this.cells, (cell) => cell.type === "assistant");
			const userIndex = findLastIndex(this.cells, (cell) => cell.type === "user");
			if (index > userIndex) {
				const cell = this.cells[index] as AssistantCell;
				this.replace(index, { ...cell, usage: { ...usage, provider, model: this.currentModel() } });
			}
		}
		const notice = STOP_REASON_NOTICES[stopReason];
		if (notice) this.addNotice(notice.level, notice.text);
	}

	/**
	 * A loaded session finished replaying its history: whatever it left open is
	 * past, not in progress.
	 */
	finishReplay(): void {
		this.closeAssistant();
		this.cells = this.cells.map((cell) =>
			cell.type === "tool" && (cell.status === "pending" || cell.status === "running") ? { ...cell, status: "done" } : cell,
		);
	}

	failTurn(message: string): void {
		this.finishTurn("failed");
		this.addNotice("error", message);
	}
}

const STOP_REASON_NOTICES: Record<string, { level: "info" | "warning"; text: string }> = {
	cancelled: { level: "info", text: "已停止" },
	max_tokens: { level: "warning", text: "回复达到了最大 token 数，已被截断" },
	max_turn_requests: { level: "warning", text: "本轮模型调用次数达到上限，代理已停止" },
	refusal: { level: "warning", text: "代理拒绝继续执行" },
};

/** Map an ACP `session/prompt` usage object onto a turn's usage. */
export function turnUsageFromAcp(usage: unknown, durationMs: number): Omit<TurnUsage, "provider" | "model"> | undefined {
	if (!isObject(usage)) return undefined;
	const number = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
	const cacheRead = number("cachedReadTokens");
	const cacheWrite = number("cachedWriteTokens");
	const reasoning = typeof usage.thoughtTokens === "number" ? usage.thoughtTokens : undefined;
	return {
		// ACP reports one aggregate per prompt, not per model call.
		calls: 1,
		// Already excludes cache hits: total = input + cacheRead + output.
		input: number("inputTokens"),
		output: number("outputTokens"),
		cacheRead,
		cacheWrite,
		...(reasoning !== undefined ? { reasoning } : {}),
		totalTokens: number("totalTokens"),
		durationMs,
	};
}
