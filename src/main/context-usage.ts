import type { ContextUsage } from "../shared/agent";

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
}

interface MessageLike {
	role: string;
	usage?: UsageLike;
	stopReason?: string;
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
): ContextUsage | null {
	if (window === undefined || !Number.isFinite(window) || window <= 0) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || !message.usage) continue;
		// An aborted or failed call reports whatever it managed before it stopped.
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const used = callTokens(message.usage);
		if (used > 0) return { used, window };
	}
	return null;
}
