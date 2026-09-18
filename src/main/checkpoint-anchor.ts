/**
 * Where a checkpoint lands in the session that is open right now.
 *
 * A checkpoint stores `leafIdBefore` — the entry the turn hung off — rather than
 * the id of the prompt itself, because that is the only value that can be read
 * before the prompt exists. Turning it back into "which message, and which row
 * of the transcript" is this module's job, and it is kept apart from the agent
 * service so it can be tested against a branch rather than against a live pi
 * session.
 *
 * Structural types, not pi's: the two fields that matter here are the entry's
 * kind and, for a message entry, whose message it is.
 */

export interface AnchorEntry {
	id: string;
	type: string;
	message?: { role?: string } | null;
}

export interface AnchorMessage {
	role?: string;
	timestamp?: unknown;
}

/**
 * The prompt entry a checkpoint sits in front of, or null when its turn is no
 * longer on the active branch.
 *
 * Scans forward from the stored parent over the bookkeeping entries a turn can
 * be preceded by — a model change, a thinking-level change, a rename — because
 * those advance the leaf without being part of any turn. Hitting an assistant
 * message first means the branch has moved on and the next prompt down belongs
 * to a different turn; rewinding to it would undo the wrong work, so this
 * reports nothing rather than guessing.
 */
export function findTurnEntry(
	branch: readonly AnchorEntry[],
	leafIdBefore: string | null,
): AnchorEntry | null {
	let start: number;
	if (leafIdBefore === null) {
		start = 0;
	} else {
		const parent = branch.findIndex((entry) => entry.id === leafIdBefore);
		if (parent === -1) return null;
		start = parent + 1;
	}
	for (let i = start; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type === "custom_message") return entry;
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "user") return null;
		return entry;
	}
	return null;
}

/**
 * The transcript cell id for a message, matching what `projectMessages` derives.
 *
 * By object identity, deliberately: the projector keys a user cell on the
 * message's timestamp and its index in the context list, and re-deriving the
 * index from the session tree would mean reimplementing what compaction does to
 * the context. The identity holds because a session entry stores the very
 * message object the agent put in its state, and reopening a session builds both
 * from the same entries.
 *
 * Returns null when the message is not in the context at all — compacted away,
 * or on a branch that was left behind. Such a checkpoint has no row to attach
 * to, which is not the same as having nothing to restore.
 */
export function cellIdForMessage(
	messages: readonly AnchorMessage[],
	message: AnchorMessage | undefined,
): string | null {
	if (!message) return null;
	const index = messages.indexOf(message);
	if (index === -1) return null;
	const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
	return `user-${timestamp}-${index}`;
}
