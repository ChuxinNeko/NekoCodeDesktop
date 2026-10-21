import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CheckpointSummary, CheckpointEditedFile } from "../shared/checkpoints";
import type { AnchorEntry, AnchorMessage } from "./checkpoint-anchor";
import { CHECKPOINT_ENTRY, checkpointLabel, fileMutation, OPAQUE_TOOLS } from "./file-journal";

/** Two branch passes, without constructing a complete reversal plan per marker. */
export function checkpointSummaries(
	branch: readonly SessionEntry[], messages: readonly AnchorMessage[], sessionId: string,
): CheckpointSummary[] {
	const summaries: CheckpointSummary[] = [];
	const byId = new Map<string, CheckpointSummary>();
	const cellIds = new Map<unknown, string>();
	messages.forEach((message, index) => {
		if (!cellIds.has(message)) cellIds.set(message, `user-${typeof message.timestamp === "number" ? message.timestamp : 0}-${index}`);
	});
	let current: CheckpointSummary | undefined;
	let files = new Map<string, CheckpointEditedFile>();
	for (const entry of branch) {
		const label = checkpointLabel(entry);
		if (label !== null) {
			current = {
				id: entry.id, sessionId, createdAt: Date.parse(entry.timestamp) || 0, label,
				cellId: null, conversationRestorable: false, codeRestorable: false,
				fileCount: 0, files: [], additions: 0, deletions: 0, shellRuns: 0,
			};
			summaries.push(current);
			byId.set(entry.id, current);
			files = new Map();
			continue;
		}
		const mutation = current && fileMutation(entry);
		if (!current || !mutation) continue;
		let file = files.get(mutation.path);
		if (!file) {
			file = { path: mutation.path, additions: 0, deletions: 0 };
			files.set(mutation.path, file);
			current.files.push(file);
			current.fileCount++;
		}
		file.additions += mutation.additions ?? 0;
		file.deletions += mutation.deletions ?? 0;
		current.additions += mutation.additions ?? 0;
		current.deletions += mutation.deletions ?? 0;
	}
	// The earliest mutation after a marker controls whether that path can be
	// restored. Walking backwards replaces each path's later pre-image state.
	const restorable = new Map<string, boolean>();
	let restorableCount = 0;
	let shellRuns = 0;
	let nextTurn: AnchorEntry | null = null;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		const summary = byId.get(entry.id);
		if (summary) {
			summary.codeRestorable = restorableCount > 0;
			summary.shellRuns = shellRuns;
			summary.conversationRestorable = nextTurn !== null;
			summary.cellId = nextTurn?.message ? cellIds.get(nextTurn.message) ?? null : null;
		}
		if (entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY) nextTurn = null;
		else if (entry.type === "custom_message") nextTurn = entry;
		else if (entry.type === "message" && entry.message.role !== "system") {
			nextTurn = entry.message.role === "user" ? entry : null;
		}
		if (entry.type === "message" && entry.message.role === "toolResult" && OPAQUE_TOOLS.includes(entry.message.toolName)) shellRuns++;
		const mutation = fileMutation(entry);
		if (!mutation) continue;
		if (restorable.get(mutation.path)) restorableCount--;
		const canRestore = !mutation.skipped;
		restorable.set(mutation.path, canRestore);
		if (canRestore) restorableCount++;
	}
	return summaries.reverse();
}
