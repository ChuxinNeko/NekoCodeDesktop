/**
 * Preferences the main process owns.
 *
 * Kept apart from the renderer's `localStorage` settings because these decide
 * what main does on its own — it announces a finished task and isolates a
 * background one whether or not a window is up to be asked.
 */
export interface AppPreferences {
	/** Announce a task finishing when it is not the one on screen. */
	notifyOnTaskFinish: boolean;
	/**
	 * Give each background task its own git worktree.
	 *
	 * Only applies where it can: a project that is not a git repository has no
	 * worktree to make, and those tasks share the directory as they always have.
	 */
	isolateBackgroundTasks: boolean;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
	notifyOnTaskFinish: true,
	isolateBackgroundTasks: true,
};
