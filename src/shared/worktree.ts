/**
 * A task's private checkout of the project.
 *
 * Parallel tasks share one repository, and before this they shared one working
 * directory with it: two agents editing at once overwrote each other, and a
 * checkpoint restore — which rewrites files from a journal — undid whatever the
 * other task had written in between. A worktree gives each task its own files
 * and its own branch, so neither of those can happen.
 */
export interface WorktreeRecord {
	sessionId: string;
	/** Kept so a session being deleted can find its worktree by file path. */
	sessionFile: string;
	/** Where the task actually works. This is the session's cwd. */
	path: string;
	branch: string;
	/** The main checkout the worktree belongs to. */
	repoRoot: string;
	/** The branch the task forked from, and where a merge sends it back. */
	base: string;
	createdAt: number;
}

/** What the worktree bar shows about a task's branch. */
export interface WorktreeStatus {
	record: WorktreeRecord;
	/** Files changed in the worktree but not yet committed to its branch. */
	dirtyFiles: number;
	/** Commits the task branch has that its base does not. */
	ahead: number;
	/** The worktree directory is gone — removed by hand, or never made. */
	missing: boolean;
}

export type WorktreeMergeResult =
	| { merged: true; commits: number }
	/**
	 * Refused before touching the main checkout. `reason` is written for the
	 * user: a merge that half-happened is far worse than one that did not start.
	 */
	| { merged: false; reason: string };

export interface WorktreeMergeRequest {
	sessionId: string;
	/** Commit message for the task's uncommitted changes, if there are any. */
	message: string;
}
