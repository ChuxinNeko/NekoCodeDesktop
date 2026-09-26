import { gunzipSync, gzipSync } from "node:zlib";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CheckpointEditedFile } from "../shared/checkpoints";
import { SHELL_TOOLS } from "../shared/hooks";

/**
 * What a checkpoint remembers, and where it lives.
 *
 * Nothing here is stored outside the session transcript. A checkpoint is a
 * marker entry in pi's session tree, and the file changes that follow it are
 * more entries beside it — which is how pi already records everything else it
 * has to remember across a reload.
 *
 * The alternative, mirroring the working tree into the app's data directory, was
 * tried and thrown away: hashing a hundred-thousand-file repository takes about
 * fifteen minutes, and the copy it produces is the size of the project. The
 * agent already knows which files it is about to change, so the cost of
 * remembering them is the size of the changes, not the size of the project.
 *
 * What this cannot undo is a change no tool call announced — a `bash` command
 * that rewrites files, or an edit made in another editor. Those are counted and
 * reported rather than silently missed.
 */

/** Custom entry marking a point the session can be put back to. */
export const CHECKPOINT_ENTRY = "nekocode.checkpoint";

/** Custom entry recording one file's contents before a tool changed them. */
export const FILE_MUTATION_ENTRY = "nekocode.file-mutation";

/** Tools whose changes are recorded, by the path in their arguments. */
export const RECORDED_TOOLS: readonly string[] = ["write", "edit"];

/** Tools that change files in ways no argument describes. */
export const OPAQUE_TOOLS: readonly string[] = SHELL_TOOLS;

/**
 * Pre-images past this are not kept.
 *
 * The transcript is a line-delimited JSON file that is read whole to open a
 * session, so a single enormous entry costs every future open. No source file an
 * agent edits is a megabyte; one that is, is an artifact.
 */
export const MAX_PREIMAGE_BYTES = 1024 * 1024;

export interface CheckpointData {
	/** The prompt the turn after this marker opened with. */
	label: string;
}

export interface FileMutationData {
	/** Workspace-relative, forward slashes. */
	path: string;
	/**
	 * The file's contents before the tool ran, gzipped and base64'd, or null when
	 * the tool created it — in which case putting things back means deleting it.
	 */
	before: string | null;
	/** Size of those contents before compression, for the confirmation to show. */
	beforeBytes: number;
	/** The tool that made the change. */
	tool: string;
	/**
	 * Lines this one tool call added and removed.
	 *
	 * Worked out when the call finishes, while both versions are still to hand,
	 * and written down rather than recomputed. The checkpoint list is rebuilt on
	 * every streaming event, so a row that had to read files and diff them to
	 * draw itself would put the transcript's frame rate on the disk.
	 *
	 * These describe the work the turn did. What *restoring* would change is a
	 * different question — it is measured against the files as they are now — and
	 * is computed on demand where it is asked.
	 */
	additions?: number;
	deletions?: number;
	/** Set instead of `before` when the file was too large to keep a copy of. */
	skipped?: "too-large" | "unreadable";
}

/** Pack a pre-image for the transcript. Text compresses to roughly a third. */
export function packPreimage(contents: Buffer): string {
	return gzipSync(contents).toString("base64");
}

export function unpackPreimage(packed: string): Buffer {
	return gunzipSync(Buffer.from(packed, "base64"));
}

function customData(entry: SessionEntry, customType: string): unknown {
	if (entry.type !== "custom" || entry.customType !== customType) return undefined;
	return entry.data;
}

/** Is this entry a checkpoint marker? Returns its label, or null. */
export function checkpointLabel(entry: SessionEntry): string | null {
	const data = customData(entry, CHECKPOINT_ENTRY);
	if (!data || typeof data !== "object") return null;
	const label = (data as CheckpointData).label;
	return typeof label === "string" ? label : "";
}

/** Is this entry a recorded file change? Returns it, or null. */
export function fileMutation(entry: SessionEntry): FileMutationData | null {
	const data = customData(entry, FILE_MUTATION_ENTRY);
	if (!data || typeof data !== "object") return null;
	const mutation = data as FileMutationData;
	if (typeof mutation.path !== "string" || !mutation.path) return null;
	if (mutation.before !== null && typeof mutation.before !== "string") return null;
	return mutation;
}

/** One file to put back, and what to put back into it. */
export interface ReversalStep {
	path: string;
	/** Null means the file did not exist at the checkpoint and should be removed. */
	before: string | null;
	beforeBytes: number;
	/** The pre-image was never kept, so this file cannot be put back. */
	skipped?: FileMutationData["skipped"];
}

export interface ReversalPlan {
	steps: ReversalStep[];
	/** Recorded changes whose pre-image was not kept, so they cannot be undone. */
	unrestorable: ReversalStep[];
	/** Shell commands that ran after the checkpoint; their effects are not recorded. */
	opaqueRuns: number;
}

/** Which tool a `toolResult` message reports on, when the entry is one. */
function toolResultName(entry: SessionEntry): string | null {
	if (entry.type !== "message") return null;
	const message = entry.message as { role?: string; toolName?: unknown };
	if (message.role !== "toolResult") return null;
	return typeof message.toolName === "string" ? message.toolName : null;
}

/**
 * What putting the files back to `checkpointId` would involve.
 *
 * The first recorded change to a file after the checkpoint is the one that holds
 * its contents *at* the checkpoint; every later change to the same file carries
 * a pre-image from after it. So the plan keeps the earliest per path and ignores
 * the rest, which is also why a file edited twenty times costs one restore.
 *
 * `branch` is the active path through the session tree, root first.
 */
export function planReversal(
	branch: readonly SessionEntry[],
	checkpointId: string,
): ReversalPlan {
	const start = branch.findIndex((entry) => entry.id === checkpointId);
	const plan: ReversalPlan = { steps: [], unrestorable: [], opaqueRuns: 0 };
	if (start === -1) return plan;

	const seen = new Set<string>();
	for (let i = start + 1; i < branch.length; i++) {
		const entry = branch[i];
		const tool = toolResultName(entry);
		if (tool && OPAQUE_TOOLS.includes(tool)) {
			plan.opaqueRuns++;
			continue;
		}
		const mutation = fileMutation(entry);
		if (!mutation || seen.has(mutation.path)) continue;
		seen.add(mutation.path);
		const step: ReversalStep = {
			path: mutation.path,
			before: mutation.before,
			beforeBytes: mutation.beforeBytes ?? 0,
			...(mutation.skipped ? { skipped: mutation.skipped } : {}),
		};
		if (step.skipped) plan.unrestorable.push(step);
		else plan.steps.push(step);
	}
	plan.steps.sort((a, b) => a.path.localeCompare(b.path));
	plan.unrestorable.sort((a, b) => a.path.localeCompare(b.path));
	return plan;
}

/** What one turn changed, summed over its own tool calls. */
export interface TurnStats {
	files: number;
	additions: number;
	deletions: number;
	/** Per-file breakdown, in the order the turn first touched each path. */
	list: CheckpointEditedFile[];
}

/**
 * The work done between one checkpoint marker and the next.
 *
 * A turn's own footprint, not the difference between then and now: it stops at
 * the following marker, so every row in the list describes its own turn rather
 * than everything that happened since. Summed from what each tool call recorded,
 * so it costs a walk of the branch and no disk at all.
 *
 * A file touched twice in one turn counts once in `files` but contributes both
 * calls' lines — the turn really did write those lines, even if some of them
 * replaced each other.
 */
export function turnStats(branch: readonly SessionEntry[], checkpointId: string): TurnStats {
	const start = branch.findIndex((entry) => entry.id === checkpointId);
	const stats: TurnStats = { files: 0, additions: 0, deletions: 0, list: [] };
	if (start === -1) return stats;

	const seen = new Map<string, CheckpointEditedFile>();
	for (let i = start + 1; i < branch.length; i++) {
		const entry = branch[i];
		if (checkpointLabel(entry) !== null) break;
		const mutation = fileMutation(entry);
		if (!mutation) continue;
		let file = seen.get(mutation.path);
		if (!file) {
			file = { path: mutation.path, additions: 0, deletions: 0 };
			seen.set(mutation.path, file);
			stats.list.push(file);
			stats.files++;
		}
		const added = mutation.additions ?? 0;
		const removed = mutation.deletions ?? 0;
		file.additions += added;
		file.deletions += removed;
		stats.additions += added;
		stats.deletions += removed;
	}
	return stats;
}

/** Checkpoint markers on the active branch, oldest first. */
export function checkpointEntries(
	branch: readonly SessionEntry[],
): { id: string; label: string; timestamp: number }[] {
	const found: { id: string; label: string; timestamp: number }[] = [];
	for (const entry of branch) {
		const label = checkpointLabel(entry);
		if (label === null) continue;
		found.push({ id: entry.id, label, timestamp: Date.parse(entry.timestamp) || 0 });
	}
	return found;
}
