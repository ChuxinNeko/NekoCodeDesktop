/**
 * Which shell the agent's commands run in.
 *
 * pi ships two command tools — `bash` (Git Bash on Windows) and `powershell`
 * (PowerShell 7 when installed, else 5.1) — and offers both. A user who picks a
 * shell in settings gets that one alone: the tool it runs through, the
 * executable behind it, and a line in the prompt naming its syntax, so the
 * model writes for the shell that will actually run it. cmd has no tool in pi,
 * so it gets one here, built from pi's own bash tool with cmd's name and
 * guidance on top.
 *
 * Execution is NekoCode's own rather than pi's local backend because that
 * backend cannot be pointed at a specific PowerShell, and has no notion of cmd.
 * It keeps pi's contract exactly: `aborted` and `timeout:<n>` errors, the whole
 * process tree killed, and output read until the pipes fall quiet after exit —
 * so a background process holding them open cannot hang the tool.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BashOperations, ToolDefinition, ToolsOptions } from "@earendil-works/pi-coding-agent";
import type { CommandShellId, CommandShellOption } from "../shared/preferences";
import { findOnPath, nodeProbe, type ExecutableProbe } from "./acp/binaries";
import { sanitizeNekoPowerShellEnvironment, sanitizeNekoShellEnvironment } from "./shell-environment";

type ShellTool = "bash" | "powershell" | "cmd";

const WINDOWS_SHELLS: readonly CommandShellId[] = ["auto", "powershell", "pwsh", "cmd", "git-bash"];
const UNIX_SHELLS: readonly CommandShellId[] = ["auto", "bash", "zsh", "sh"];

/** The tool each shell runs through: its syntax family, as the model sees it. */
const SHELL_TOOL: Record<Exclude<CommandShellId, "auto">, ShellTool> = {
	powershell: "powershell",
	pwsh: "powershell",
	cmd: "cmd",
	"git-bash": "bash",
	bash: "bash",
	zsh: "bash",
	sh: "bash",
};

/** Named in the prompt so the model writes this shell's syntax and no other. */
const SHELL_PROMPT_NOTES: Record<Exclude<CommandShellId, "auto">, string> = {
	powershell:
		"命令 shell：本会话的命令由 powershell 工具在 Windows PowerShell 5.1 中执行。使用 PowerShell 5.1 语法：它不支持 && 和 ||，用分号分隔命令，用 if ($?) { … } 表达条件执行。",
	pwsh: "命令 shell：本会话的命令由 powershell 工具在 PowerShell 7（pwsh）中执行，使用 PowerShell 语法（支持 && 与 ||）。",
	cmd: "命令 shell：本会话的命令由 cmd 工具在 Windows 命令提示符（cmd.exe）中执行。只使用 cmd 语法：dir、type、copy、set、%VAR%、&&、||；不要写 PowerShell 或 bash 语法，需要时显式调用 powershell -Command 或其他程序。",
	"git-bash": "命令 shell：本会话的命令由 bash 工具在 Git Bash 中执行，使用 bash 语法；Windows 路径可写成 /c/Users/... 或加引号的 C:\\Users\\...。",
	bash: "命令 shell：本会话的命令由 bash 工具在 bash 中执行。",
	zsh: "命令 shell：本会话的命令由 bash 工具在 zsh 中执行，使用 zsh 兼容的语法。",
	sh: "命令 shell：本会话的命令由 bash 工具在 POSIX sh 中执行，只使用 POSIX sh 语法，不要用 bash 专有特性（如 [[ ]]、数组）。",
};

function envValue(env: ExecutableProbe["env"], name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
	return key ? env[key] : undefined;
}

function firstFile(paths: readonly (string | undefined)[], probe: ExecutableProbe): string | undefined {
	return paths.find((path): path is string => !!path && probe.isFile(path));
}

/**
 * Git for Windows' `bin\bash.exe`, the launcher that sets up its environment —
 * never `System32\bash.exe`, which is WSL and a different machine entirely.
 */
function gitBash(probe: ExecutableProbe): string | undefined {
	const roots = [envValue(probe.env, "PROGRAMFILES"), envValue(probe.env, "PROGRAMFILES(X86)")]
		.filter((root): root is string => !!root)
		.map((root) => join(root, "Git"));
	const localAppData = envValue(probe.env, "LOCALAPPDATA");
	if (localAppData) roots.push(join(localAppData, "Programs", "Git"));
	// A Git elsewhere is found through its `cmd\git.exe` on PATH.
	const git = findOnPath(["git.exe"], probe);
	if (git) roots.push(join(git, "..", ".."));
	return firstFile(roots.map((root) => join(root, "bin", "bash.exe")), probe);
}

/** Where a shell is installed, or undefined when it is not. */
export function resolveShellExecutable(id: CommandShellId, probe: ExecutableProbe = nodeProbe()): string | undefined {
	const systemRoot = envValue(probe.env, "SYSTEMROOT") ?? "C:\\Windows";
	switch (id) {
		case "auto":
			return undefined;
		case "powershell":
			return firstFile([join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")], probe) ?? findOnPath(["powershell.exe"], probe);
		case "pwsh": {
			const programFiles = envValue(probe.env, "PROGRAMFILES");
			const localAppData = envValue(probe.env, "LOCALAPPDATA");
			return (
				findOnPath(["pwsh.exe"], probe) ??
				firstFile(
					[
						programFiles && join(programFiles, "PowerShell", "7", "pwsh.exe"),
						programFiles && join(programFiles, "PowerShell", "7-preview", "pwsh.exe"),
						localAppData && join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe"),
					],
					probe,
				)
			);
		}
		case "cmd":
			return firstFile([envValue(probe.env, "COMSPEC"), join(systemRoot, "System32", "cmd.exe")], probe);
		case "git-bash":
			return gitBash(probe);
		case "bash":
			return firstFile(["/bin/bash"], probe) ?? findOnPath(["bash"], probe);
		case "zsh":
			return firstFile(["/bin/zsh"], probe) ?? findOnPath(["zsh"], probe);
		case "sh":
			return firstFile(["/bin/sh"], probe) ?? findOnPath(["sh"], probe);
	}
}

/** The shells this platform offers, and where each one is. */
export function listCommandShells(probe: ExecutableProbe = nodeProbe()): CommandShellOption[] {
	const ids = probe.platform === "win32" ? WINDOWS_SHELLS : UNIX_SHELLS;
	return ids.map((id) => ({ id, path: id === "auto" ? null : (resolveShellExecutable(id, probe) ?? null) }));
}

// --- running a command ---------------------------------------------------------

const EXIT_STDIO_GRACE_MS = 100;
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Makes a PowerShell write UTF-8, whatever the console's code page; pi does the same. */
const POWERSHELL_UTF8_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

export interface ShellInvocation {
	file: string;
	args: string[];
	/** cmd takes its command line as written; Node's argv quoting would mangle it. */
	verbatim?: boolean;
	/** Added to the command's environment. */
	env?: Record<string, string>;
}

const CMD_LINE_VARIABLE = "NEKOCODE_CMD_LINE";

/** How one command is handed to a shell. */
export function shellInvocation(tool: ShellTool, executable: string, command: string): ShellInvocation {
	if (tool === "powershell") return { file: executable, args: [...POWERSHELL_ARGS, `${POWERSHELL_UTF8_PREFIX}${command}`] };
	if (tool === "cmd") {
		// cmd's own commands (echo, dir, type) write in the code page cmd had
		// when it read the line, so a `chcp` on the same line comes too late for
		// them. An outer cmd switches to UTF-8 and starts the one that runs the
		// command, which then starts in 65001. The command travels in a variable
		// expanded late (`!…!`), so the outer cmd never parses its &, | or quotes;
		// the inner one reads it as typed at a prompt — `/s /c "…"` strips just
		// the outer quotes.
		return {
			file: executable,
			args: [`/d /v:on /s /c "chcp 65001>nul & "${executable}" /d /s /c !${CMD_LINE_VARIABLE}!"`],
			env: { [CMD_LINE_VARIABLE]: `"${command}"` },
			verbatim: true,
		};
	}
	return { file: executable, args: ["-c", command] };
}

function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (!pid) return;
	if (process.platform === "win32") {
		const taskkill = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			windowsHide: true,
		});
		taskkill.once("error", () => {});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

/** Resolves with the exit code once the pipes are drained or have gone quiet. */
function waitForExit(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exitCode: number | null = null;
		let exited = false;
		let idle: NodeJS.Timeout | undefined;
		let open = (child.stdout ? 1 : 0) + (child.stderr ? 1 : 0);
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			if (idle) clearTimeout(idle);
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};
		const arm = () => {
			if (idle) clearTimeout(idle);
			idle = setTimeout(() => finish(exitCode), EXIT_STDIO_GRACE_MS);
		};
		const ended = () => {
			open--;
			if (exited && open <= 0) finish(exitCode);
		};
		child.stdout?.once("end", ended);
		child.stderr?.once("end", ended);
		// Output still arriving after exit keeps the wait open; a quiet inherited
		// handle releases it after the grace period.
		child.stdout?.on("data", () => exited && arm());
		child.stderr?.on("data", () => exited && arm());
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			if (idle) clearTimeout(idle);
			reject(error);
		});
		child.once("exit", (code) => {
			exited = true;
			exitCode = code;
			if (open <= 0) finish(code);
			else arm();
		});
		child.once("close", (code) => finish(code));
	});
}

/** pi's `BashOperations`, running every command through one chosen shell. */
export function createShellOperations(tool: ShellTool, executable: string): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > MAX_TIMEOUT_MS)) {
				throw new Error("Invalid timeout: must be a positive number of seconds");
			}
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
			const invocation = shellInvocation(tool, executable, command);
			const child = spawn(invocation.file, invocation.args, {
				cwd,
				env: { ...(env ?? process.env), ...invocation.env },
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				// Its own process group on Unix, so the whole tree can be killed at once.
				detached: process.platform !== "win32",
				...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
			});
			let timedOut = false;
			const timer =
				timeout !== undefined
					? setTimeout(() => {
							timedOut = true;
							killTree(child);
						}, timeout * 1000)
					: undefined;
			const onAbort = () => killTree(child);
			signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			try {
				const exitCode = await waitForExit(child);
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				return { exitCode };
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

// --- what a session gets ---------------------------------------------------------

type CreateBashToolDefinition = typeof import("@earendil-works/pi-coding-agent").createBashToolDefinition;
type ShellToolDefinition = ToolDefinition;

export interface CommandShellSetup {
	/** The shell in force; `auto` when the chosen one is missing, too. */
	id: CommandShellId;
	/** The shell tools the model may call, in place of whatever a mode lists. */
	shellTools: readonly string[];
	toolOptions: ToolsOptions;
	/** Tools pi has no built-in for — cmd's. */
	customTools(cwd: string, createBashToolDefinition: CreateBashToolDefinition): ShellToolDefinition[];
	/** Tells the model which shell it is writing for. */
	promptNote?: string;
}

const spawnHook = sanitizeNekoShellEnvironment;
const powershellSpawnHook = sanitizeNekoPowerShellEnvironment;
const AUTO: CommandShellSetup = {
	id: "auto",
	shellTools: ["bash", "powershell"],
	toolOptions: { bash: { spawnHook }, powershell: { spawnHook: powershellSpawnHook } },
	customTools: () => [],
};

/** pi's bash tool, renamed and re-described as cmd, running through cmd.exe. */
function cmdTool(cwd: string, executable: string, createBashToolDefinition: CreateBashToolDefinition): ShellToolDefinition {
	const base = createBashToolDefinition(cwd, { spawnHook, operations: createShellOperations("cmd", executable) });
	const tool = {
		...base,
		name: "cmd",
		label: "cmd",
		description: base.description.replace(/\bbash\b/g, "Windows cmd.exe"),
		promptSnippet: "Execute Windows Command Prompt (cmd.exe) commands",
	};
	// Typed to its own argument schema, which the generic list does not widen to;
	// pi registers this very object as its own bash tool the same way.
	return tool as unknown as ToolDefinition;
}

/**
 * Everything a new session needs to run commands through one shell. A shell
 * that was chosen but is no longer installed falls back to automatic rather
 * than leaving the agent with a command tool that cannot start.
 */
export function commandShellSetup(id: CommandShellId, probe: ExecutableProbe = nodeProbe()): CommandShellSetup {
	if (id === "auto") return AUTO;
	const allowed = (probe.platform === "win32" ? WINDOWS_SHELLS : UNIX_SHELLS).includes(id);
	const executable = allowed ? resolveShellExecutable(id, probe) : undefined;
	if (!executable) return AUTO;
	const tool = SHELL_TOOL[id];
	const operations = createShellOperations(tool, executable);
	return {
		id,
		shellTools: [tool],
		toolOptions:
			tool === "powershell"
				? { bash: { spawnHook }, powershell: { spawnHook: powershellSpawnHook, operations } }
				: tool === "bash"
					? { bash: { spawnHook, operations }, powershell: { spawnHook: powershellSpawnHook } }
					: AUTO.toolOptions,
		customTools: (cwd, create) => (tool === "cmd" ? [cmdTool(cwd, executable, create)] : []),
		promptNote: SHELL_PROMPT_NOTES[id],
	};
}

let preference: () => CommandShellId = () => "auto";

/** Where new sessions read the chosen shell from; set once at startup. */
export function configureCommandShell(read: () => CommandShellId): void {
	preference = read;
}

/** The setup for a session starting now. */
export function currentCommandShell(): CommandShellSetup {
	return commandShellSetup(preference());
}
