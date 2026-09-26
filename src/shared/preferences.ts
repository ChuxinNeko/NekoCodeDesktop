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
	/**
	 * Give the agent Computer Use tools: reading and operating other apps'
	 * windows on this desktop. Off by default — it acts outside the project,
	 * on whatever the user has open. Takes effect for sessions started after.
	 */
	computerUse: boolean;
	/**
	 * The shell the agent's commands run in. `auto` keeps both command tools —
	 * bash (Git Bash on Windows) and PowerShell — and lets the model choose; any
	 * other value gives it that one shell alone. Takes effect for sessions
	 * started after.
	 */
	commandShell: CommandShellId;
}

/**
 * The shells a user can pick. Windows: PowerShell 5.1, PowerShell 7, cmd and
 * Git Bash. macOS and Linux: bash, zsh and sh.
 */
export const COMMAND_SHELL_IDS = ["auto", "powershell", "pwsh", "cmd", "git-bash", "bash", "zsh", "sh"] as const;
export type CommandShellId = (typeof COMMAND_SHELL_IDS)[number];

export function isCommandShellId(value: unknown): value is CommandShellId {
	return typeof value === "string" && (COMMAND_SHELL_IDS as readonly string[]).includes(value);
}

/** One shell as the settings page offers it. */
export interface CommandShellOption {
	id: CommandShellId;
	/** Where it was found; null when it is not installed on this machine. */
	path: string | null;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
	notifyOnTaskFinish: true,
	isolateBackgroundTasks: true,
	computerUse: false,
	commandShell: "auto",
};
