/**
 * Checkpoints: a point in a session you can put the project back to.
 *
 * One checkpoint pairs two independent things — the files the agent has changed
 * since, and the position in the session tree — because undoing a turn usually
 * means both, but not always. Reviewing what the agent wrote and deciding the
 * code was wrong but the discussion was not is a real situation, and so is the
 * reverse. The scopes are therefore separate and the confirmation names which
 * one runs.
 *
 * Both halves live in the session transcript and nowhere else. Nothing is copied
 * into the app's data directory, so the disk cost of a checkpoint is the size of
 * what changed rather than the size of the project.
 */

/** What a restore would do to one file. */
export interface CheckpointFileChange {
	/** Workspace-relative, forward slashes. */
	path: string;
	/**
	 * From the restore's point of view:
	 * - `delete` — the agent created the file, restoring removes it
	 * - `overwrite` — the agent changed it, restoring puts the old contents back
	 * - `recreate` — the agent removed it, restoring brings it back
	 */
	action: "delete" | "overwrite" | "recreate";
	/** Size of the file as the checkpoint has it; 0 for `delete`. */
	bytes: number;
	/** Lines the agent added since the checkpoint. */
	additions: number;
	/** Lines the agent removed since the checkpoint. */
	deletions: number;
	/** Neither side is text, so there is no diff to show. */
	binary: boolean;
}

/** One file's changes since a checkpoint, as a unified diff. */
export interface CheckpointFileDiff {
	path: string;
	/** Unified diff from the checkpoint's contents to the file as it is now. */
	patch: string;
	additions: number;
	deletions: number;
	binary: boolean;
}

/** What restoring a checkpoint's code would change, measured against the tree right now. */
export interface CheckpointDiff {
	/** A sample of the changes, for the confirmation to list. */
	changes: CheckpointFileChange[];
	/** More files changed than `changes` lists. */
	truncated: boolean;
	/** Total files the restore would touch, including any past the preview limit. */
	total: number;
	additions: number;
	deletions: number;
	/** Counts over every change, not only the listed ones. */
	counts: { overwrite: number; recreate: number; delete: number };
	/**
	 * Files the agent changed that cannot be put back, because the copy was too
	 * large to keep or could not be read at the time.
	 */
	unrestorable: string[];
	/**
	 * Shell commands that ran after this checkpoint.
	 *
	 * A shell command announces a command line, not a file list, so whatever it
	 * changed was never recorded and will survive the restore. Surfaced rather
	 * than hidden: "restored" has to mean the same thing every time.
	 */
	shellRuns: number;
}

/** One file a turn's tool calls changed, summed over the calls that touched it. */
export interface CheckpointEditedFile {
	/** Workspace-relative, forward slashes. */
	path: string;
	/** Lines the turn's tool calls added to it, all calls counted. */
	additions: number;
	/** Lines the turn's tool calls removed from it, all calls counted. */
	deletions: number;
}

export interface CheckpointSummary {
	/** The session entry that marks this point. */
	id: string;
	sessionId: string;
	createdAt: number;
	/** The prompt that opened the turn this checkpoint sits in front of. */
	label: string;
	/**
	 * The transcript cell this checkpoint belongs in front of, when it is still
	 * on the active branch. Null once the conversation has moved off it.
	 */
	cellId: string | null;
	/** The session tree can still be rewound to this point. */
	conversationRestorable: boolean;
	/** The agent changed files after this point that can be put back. */
	codeRestorable: boolean;
	/** Files the agent changed in the turn this checkpoint fronts. */
	fileCount: number;
	/** Those files themselves, in the order the turn first touched each. */
	files: CheckpointEditedFile[];
	additions: number;
	deletions: number;
	/** Shell commands that ran since; their effects are not recorded. */
	shellRuns: number;
}

export type CheckpointScope = "code" | "conversation" | "both";

export interface CheckpointPreview {
	checkpoint: CheckpointSummary;
	diff: CheckpointDiff;
}

export interface RestoreCheckpointRequest {
	id: string;
	scope: CheckpointScope;
}

export interface RestoreCheckpointResult {
	/** Files written back to their checkpoint contents. */
	restored: number;
	/** Files removed because they did not exist at the checkpoint. */
	deleted: number;
	conversationRewound: boolean;
	/**
	 * The prompt that started the undone turn, handed back so the composer can
	 * be refilled with it — rewinding is almost always a prelude to asking again
	 * differently, and retyping it is the part nobody wants.
	 */
	editorText?: string;
	/** Anything that could not be done. */
	warnings: string[];
}

/** Nothing to restore: every action would be a no-op. */
export function isEmptyDiff(diff: CheckpointDiff): boolean {
	return diff.total === 0;
}
