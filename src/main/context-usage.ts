import type { ContextCategory, ContextUsage } from "../shared/agent";

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
}

interface MessageLike {
	role: string;
	content?: unknown;
	sections?: Record<string, string | null>;
	toolsAdded?: readonly { name: string; namespace?: string; description?: string; parameters?: unknown }[];
	toolsRemoved?: readonly { name: string; namespace?: string }[];
	usage?: UsageLike;
	stopReason?: string;
}

/** Character-based estimates only; provider usage remains the authoritative total. */
function estimate(text: string): number {
	const wide = text.match(/[\u2e80-\u9fff\uac00-\ud7af]/g)?.length ?? 0;
	return Math.ceil((text.length - wide) / 4 + wide);
}

function breakdown(messages: readonly MessageLike[], used: number): NonNullable<ContextUsage["breakdown"]> | undefined {
	const parts: Record<ContextCategory, number> = { system: 0, tools: 0, rules: 0, skills: 0, mcp: 0, subagents: 0, conversation: 0 };
	const sections = new Map<string, string>();
	const tools = new Map<string, NonNullable<MessageLike["toolsAdded"]>[number]>();
	let hasSystem = false;
	for (const message of messages) {
		if (message.role !== "system") continue;
		hasSystem = true;
		if (typeof message.content === "string") parts.system += estimate(message.content);
		else if (Array.isArray(message.content)) {
			for (const block of message.content) if (block?.type === "text" && typeof block.text === "string") parts.system += estimate(block.text);
		}
		for (const [name, content] of Object.entries(message.sections ?? {})) {
			if (content === null) sections.delete(name);
			else sections.set(name, content);
		}
		for (const tool of message.toolsAdded ?? []) tools.set(`${tool.namespace ?? ""}:${tool.name}`, tool);
		for (const tool of message.toolsRemoved ?? []) tools.delete(`${tool.namespace ?? ""}:${tool.name}`);
	}
	if (!hasSystem) return undefined;
	for (const [name, text] of sections) {
		const category: ContextCategory = ["rules", "project_context", "tool_guidelines"].includes(name) ? "rules"
			: name === "skills" ? "skills" : /^(subagents?|agent_definitions)$/.test(name) ? "subagents"
				: /^(mcp|dynamic_tools)$/.test(name) ? "mcp" : "system";
		parts[category] += estimate(text);
	}
	for (const tool of tools.values()) {
		parts[tool.name.startsWith("mcp__") || tool.namespace?.startsWith("mcp") ? "mcp" : "tools"] += estimate(JSON.stringify(tool));
	}
	const fixed = Object.values(parts).reduce((sum, value) => sum + value, 0);
	// Small reported totals and different tokenizers must never produce an overflowing report.
	if (fixed > used) for (const key of Object.keys(parts) as ContextCategory[]) parts[key] = Math.floor(parts[key] * used / fixed);
	parts.conversation = used - Object.values(parts).reduce((sum, value) => sum + value, 0);
	return parts;
}

/**
 * What one model call carried: its entire prompt plus the reply.
 *
 * `input`, `cacheRead` and `cacheWrite` partition the prompt rather than
 * overlapping — a cached prefix is counted once, under `cacheRead` — so adding
 * the three back together is the conversation, not a multiple of it.
 *
 * Deliberately the same arithmetic PI uses to decide when to auto-compact
 * (`calculateContextTokens`), so the gauge and the compaction it warns about
 * are reading the same number rather than two plausible ones.
 */
function callTokens(usage: UsageLike): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * How much of the context window the conversation currently occupies.
 *
 * Read off the newest assistant message that reported usage, not summed over
 * the turn: a turn with ten tool calls re-sends the whole conversation ten
 * times, so its totals are a bill, not an occupancy. Walking backwards also
 * lands after a compaction rather than on the stale, larger figures the kept
 * pre-compaction messages still carry.
 *
 * Null until a reply has come back, or when the model declares no window —
 * a ring with nothing behind it is worse than no ring.
 */
export function contextUsage(
	messages: readonly MessageLike[],
	window: number | undefined,
	includeBreakdown = false,
): ContextUsage | null {
	if (window === undefined || !Number.isFinite(window) || window <= 0) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || !message.usage) continue;
		// An aborted or failed call reports whatever it managed before it stopped.
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const used = callTokens(message.usage);
		if (Number.isFinite(used) && used > 0) {
			const details = includeBreakdown ? breakdown(messages.slice(0, i + 1), used) : undefined;
			return { used, window, ...(details ? { breakdown: details, breakdownEstimated: true } : {}) };
		}
	}
	return null;
}
