/**
 * Hooks: the user's own rules around the agent's tool calls.
 *
 * Configured in the app, never read from the repository. A hook runs a shell
 * command, and a hook file that arrived with a `git clone` would be a way for
 * whoever wrote the repository to run code on this machine the moment the
 * agent touched it.
 */

export type HookEvent = "pre_tool" | "post_tool";

/**
 * What a pre-tool hook does when it matches.
 *
 * `block` needs no command — refusing `rm -rf` should not take a script. A
 * `command` hook decides for itself: exit 0 lets the call through, anything
 * else blocks it with the output as the reason.
 */
export type PreToolAction = "block" | "command";

export interface HookConfig {
	id: string;
	name: string;
	enabled: boolean;
	event: HookEvent;
	/** Tool names this applies to; empty means every tool. */
	tools: string[];
	/**
	 * Regular expression over the call's subject — the command line for shell
	 * tools, the path for file tools, the JSON arguments for anything else.
	 * Empty matches everything the tool filter let through.
	 */
	pattern: string;
	/** Pre-tool only. Post-tool hooks always run their command. */
	action: PreToolAction;
	/** The shell command; unused by a `block` hook. */
	command: string;
	/** Shown to the model when a `block` hook refuses a call. */
	message: string;
	/** Limit to one project root; empty applies everywhere. */
	project: string;
	timeoutMs: number;
}

export type SaveHookRequest = Omit<HookConfig, "id"> & { id?: string };

/** One run of a hook, for the settings page to show what has been happening. */
export interface HookRunRecord {
	hookId: string;
	hookName: string;
	event: HookEvent;
	tool: string;
	subject: string;
	/** `blocked` for a pre-tool refusal, `failed` for a non-zero post-tool run. */
	outcome: "passed" | "blocked" | "failed" | "error";
	output: string;
	at: number;
	durationMs: number;
}

export interface HooksSnapshot {
	hooks: HookConfig[];
	/** Newest first. */
	recent: HookRunRecord[];
}

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
export const MAX_HOOK_TIMEOUT_MS = 10 * 60_000;
/** Output kept per run, and passed back to the model. */
export const MAX_HOOK_OUTPUT = 8000;

export const FILE_TOOLS = ["read", "write", "edit"] as const;
/** Every tool that runs shell commands — `cmd` exists when the user picks cmd as the command shell. */
export const SHELL_TOOLS = ["bash", "powershell", "cmd"] as const;

export function isShellTool(name: string): boolean {
	return (SHELL_TOOLS as readonly string[]).includes(name);
}

/**
 * What a hook's pattern is tested against for one call.
 *
 * Shared so the settings page can say exactly what a pattern will see, and so
 * main and its tests agree on it.
 */
export function hookSubject(tool: string, args: unknown): string {
	const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	if ((SHELL_TOOLS as readonly string[]).includes(tool) && typeof record.command === "string") return record.command;
	if ((FILE_TOOLS as readonly string[]).includes(tool) && typeof record.path === "string") return record.path;
	try {
		return JSON.stringify(args) ?? "";
	} catch {
		return "";
	}
}

/** Whether a hook applies to a tool call, before any project check. */
export function hookMatches(hook: Pick<HookConfig, "tools" | "pattern">, tool: string, subject: string): boolean {
	if (hook.tools.length > 0 && !hook.tools.includes(tool)) return false;
	if (!hook.pattern.trim()) return true;
	try {
		return new RegExp(hook.pattern, "i").test(subject);
	} catch {
		// A pattern that does not compile matches nothing: failing open would turn
		// a typo in a block rule into a rule that blocks everything.
		return false;
	}
}

/** A problem with a hook as written, or null. Checked in both processes. */
export function validateHook(hook: SaveHookRequest): string | null {
	if (!hook.name.trim()) return "name";
	if (hook.pattern.trim()) {
		try {
			new RegExp(hook.pattern, "i");
		} catch {
			return "pattern";
		}
	}
	const needsCommand = hook.event === "post_tool" || hook.action === "command";
	if (needsCommand && !hook.command.trim()) return "command";
	if (!Number.isFinite(hook.timeoutMs) || hook.timeoutMs < 1000 || hook.timeoutMs > MAX_HOOK_TIMEOUT_MS) return "timeout";
	return null;
}
