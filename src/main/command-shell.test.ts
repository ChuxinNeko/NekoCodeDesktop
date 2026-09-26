import { describe, expect, test } from "bun:test";
import { join, sep } from "node:path";
import type { ExecutableProbe } from "./acp/binaries";
import { sanitizePreferences } from "./app-preferences";
import { sanitizeNekoPowerShellEnvironment } from "./shell-environment";
import {
	commandShellSetup,
	createShellOperations,
	listCommandShells,
	resolveShellExecutable,
	shellInvocation,
} from "./command-shell";
import { buildModePrompt, toolsForMode, type PromptContext } from "./prompt-library";

const WIN = "C:\\Windows";
const PF = "C:\\Program Files";
const LOCAL = join("C:", "Users", "neko", "AppData", "Local");

function probe(files: string[], overrides: Partial<ExecutableProbe> = {}): ExecutableProbe {
	const set = new Set(files);
	return {
		platform: "win32",
		arch: "x64",
		env: { Path: join("C:", "bin"), SystemRoot: WIN, ProgramFiles: PF, LOCALAPPDATA: LOCAL, ComSpec: join(WIN, "System32", "cmd.exe") },
		homeDir: join("C:", "Users", "neko"),
		isFile: (path) => set.has(path),
		subdirectories: () => [],
		...overrides,
	};
}

const POWERSHELL = join(WIN, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const PWSH = join(PF, "PowerShell", "7", "pwsh.exe");
const CMD = join(WIN, "System32", "cmd.exe");
const GIT_BASH = join(PF, "Git", "bin", "bash.exe");

describe("finding each shell", () => {
	test("Windows: PowerShell 5.1, PowerShell 7, cmd and Git Bash where their installers put them", () => {
		const machine = probe([POWERSHELL, PWSH, CMD, GIT_BASH]);
		expect(resolveShellExecutable("powershell", machine)).toBe(POWERSHELL);
		expect(resolveShellExecutable("pwsh", machine)).toBe(PWSH);
		expect(resolveShellExecutable("cmd", machine)).toBe(CMD);
		expect(resolveShellExecutable("git-bash", machine)).toBe(GIT_BASH);
	});

	test("Git Bash is found through git.exe on PATH; WSL's bash never counts", () => {
		const root = join("D:", "tools", "Git");
		const git = join(root, "cmd", "git.exe");
		const bash = join(root, "bin", "bash.exe");
		const machine = probe([git, bash, join(WIN, "System32", "bash.exe")], {
			env: { Path: join(root, "cmd"), SystemRoot: WIN },
		});
		expect(resolveShellExecutable("git-bash", machine)).toBe(bash);
		expect(resolveShellExecutable("git-bash", probe([join(WIN, "System32", "bash.exe")]))).toBeUndefined();
	});

	test("the list names every shell of the platform, installed or not", () => {
		expect(listCommandShells(probe([POWERSHELL, CMD]))).toEqual([
			{ id: "auto", path: null },
			{ id: "powershell", path: POWERSHELL },
			{ id: "pwsh", path: null },
			{ id: "cmd", path: CMD },
			{ id: "git-bash", path: null },
		]);
		const unix = probe(["/bin/bash", "/bin/sh"], { platform: "darwin", env: { PATH: "/usr/bin" } });
		expect(listCommandShells(unix).map((shell) => [shell.id, shell.path])).toEqual([
			["auto", null],
			["bash", "/bin/bash"],
			["zsh", null],
			["sh", "/bin/sh"],
		]);
	});
});

describe("what a session gets", () => {
	test("automatic keeps both of pi's tools and says nothing", () => {
		const setup = commandShellSetup("auto", probe([]));
		expect(setup.shellTools).toEqual(["bash", "powershell"]);
		expect(setup.promptNote).toBeUndefined();
		expect(setup.toolOptions.bash?.operations).toBeUndefined();
	});

	test("each shell runs through the tool of its syntax, with operations of its own", () => {
		const machine = probe([POWERSHELL, PWSH, CMD, GIT_BASH]);
		const ps = commandShellSetup("powershell", machine);
		expect(ps.shellTools).toEqual(["powershell"]);
		expect(ps.toolOptions.powershell?.operations).toBeDefined();
		expect(ps.promptNote).toContain("5.1");
		expect(commandShellSetup("pwsh", machine).promptNote).toContain("PowerShell 7");
		const bash = commandShellSetup("git-bash", machine);
		expect(bash.shellTools).toEqual(["bash"]);
		expect(bash.toolOptions.bash?.operations).toBeDefined();
		const cmd = commandShellSetup("cmd", machine);
		expect(cmd.shellTools).toEqual(["cmd"]);
		expect(cmd.promptNote).toContain("cmd.exe");
	});

	test("cmd is pi's bash tool under cmd's name and description", () => {
		const cmd = commandShellSetup("cmd", probe([CMD]));
		const created: unknown[] = [];
		const [tool] = cmd.customTools("/project", ((cwd: string, options: unknown) => {
			created.push(options);
			return { name: "bash", label: "bash", description: "Execute a bash command in the current working directory.", parameters: {} };
		}) as never);
		expect(tool).toMatchObject({ name: "cmd", label: "cmd", description: "Execute a Windows cmd.exe command in the current working directory." });
		expect(created[0]).toMatchObject({ operations: expect.any(Object), spawnHook: expect.any(Function) });
		expect(commandShellSetup("powershell", probe([POWERSHELL])).customTools("/p", (() => ({})) as never)).toEqual([]);
	});

	test("a shell that is gone, or not of this platform, falls back to automatic", () => {
		expect(commandShellSetup("pwsh", probe([POWERSHELL])).id).toBe("auto");
		expect(commandShellSetup("zsh", probe(["/bin/zsh"])).id).toBe("auto");
	});

	test("how a command reaches each shell", () => {
		expect(shellInvocation("cmd", CMD, 'echo "hi" && dir')).toEqual({
			file: CMD,
			args: [`/d /v:on /s /c "chcp 65001>nul & "${CMD}" /d /s /c !NEKOCODE_CMD_LINE!"`],
			env: { NEKOCODE_CMD_LINE: '"echo "hi" && dir"' },
			verbatim: true,
		});
		const ps = shellInvocation("powershell", PWSH, "Get-Date");
		expect(ps.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
		expect(ps.args[5]).toEndWith("Get-Date");
		expect(shellInvocation("bash", GIT_BASH, "ls -la")).toEqual({ file: GIT_BASH, args: ["-c", "ls -la"] });
	});
});

describe("the tool set and prompt follow the chosen shell", () => {
	const execute: PromptContext = { mode: "agent", phase: "execute", permission: "auto", interactive: true };

	test("the chosen shell's tool stands in for bash and powershell", () => {
		const tools = toolsForMode({ ...execute, shellTools: ["cmd"] });
		expect(tools).toContain("cmd");
		expect(tools).not.toContain("bash");
		expect(tools).not.toContain("powershell");
		expect(toolsForMode(execute)).toEqual(expect.arrayContaining(["bash", "powershell"]));
	});

	test("a mode without a shell does not gain one", () => {
		const readOnly = toolsForMode({ ...execute, permission: "read-only", shellTools: ["cmd"] });
		expect(readOnly).not.toContain("cmd");
		const child = toolsForMode({ ...execute, child: true, shellTools: ["cmd"] });
		expect(child).not.toContain("cmd");
		expect(toolsForMode({ ...execute, child: true, allowWorkerShell: true, shellTools: ["cmd"] })).toContain("cmd");
	});

	test("the prompt names the shell only where a shell tool is offered", () => {
		const note = "命令 shell：cmd";
		expect(buildModePrompt({ ...execute, shellTools: ["cmd"], shellNote: note })).toContain(note);
		expect(buildModePrompt({ ...execute, permission: "read-only", shellTools: ["cmd"], shellNote: note })).not.toContain(note);
	});
});

test("preferences keep only a known shell", () => {
	expect(sanitizePreferences({ commandShell: "pwsh", computerUse: true })).toEqual({ commandShell: "pwsh", computerUse: true });
	expect(sanitizePreferences({ commandShell: "fish", computerUse: "yes" })).toEqual({});
});

describe.if(process.platform === "win32")("running commands on this machine", () => {
	const run = async (tool: "cmd" | "powershell" | "bash", executable: string, command: string, options: { timeout?: number; signal?: AbortSignal } = {}) => {
		let output = "";
		const result = await createShellOperations(tool, executable).exec(command, process.cwd(), {
			onData: (data) => {
				output += data.toString("utf8");
			},
			...options,
		});
		return { output, exitCode: result.exitCode };
	};
	const cmd = resolveShellExecutable("cmd");
	const ps = resolveShellExecutable("powershell");
	const pwsh = resolveShellExecutable("pwsh");
	const bash = resolveShellExecutable("git-bash");

	test.if(!!cmd)("cmd: cmd syntax, UTF-8 output, exit codes", async () => {
		// cmd's own echo writes UTF-8; quotes, & inside them, ! and %VAR% behave as at a prompt.
		const ok = await run("cmd", cmd!, 'echo 你好 "a & b" hi! && echo %OS%');
		expect(ok.exitCode).toBe(0);
		expect(ok.output).toContain('你好 "a & b" hi!');
		expect(ok.output).toContain("Windows_NT");
		const loop = await run("cmd", cmd!, "for %i in (1 2) do @echo item %i");
		expect(loop.output.replace(/\r/g, "")).toContain("item 1\nitem 2");
		expect((await run("cmd", cmd!, "exit /b 3")).exitCode).toBe(3);
	});

	test.if(!!ps)("Windows PowerShell runs PowerShell, in UTF-8", async () => {
		const result = await run("powershell", ps!, '$PSVersionTable.PSVersion.Major; Write-Output "中文"');
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("5");
		expect(result.output).toContain("中文");
	});

	test.if(!!pwsh)("PowerShell 7 takes && chains", async () => {
		const result = await run("powershell", pwsh!, 'Write-Output a && Write-Output "b c"');
		expect(result.output.replace(/\r/g, "")).toContain("a\nb c");
	});

	test.if(!!bash)("Git Bash runs bash", async () => {
		const result = await run("bash", bash!, 'x=$((1+2)); echo "sum $x"');
		expect(result.output).toContain("sum 3");
	});

	test.if(!!cmd)("a timeout kills the command and says so", async () => {
		const started = Date.now();
		await expect(run("cmd", cmd!, "ping -n 30 127.0.0.1 >nul", { timeout: 1 })).rejects.toThrow("timeout:1");
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	test.if(!!cmd)("an abort kills the command", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		await expect(run("cmd", cmd!, "ping -n 30 127.0.0.1 >nul", { signal: controller.signal })).rejects.toThrow("aborted");
	});
});

/** An escape sequence, or what is left of one once the ESC byte is stripped. */
const ANSI = /\u001b|\[\d+(;\d+)*m/;

describe("PowerShell output is plain text", () => {
	test("the hook asks for plain rendering and a dumb terminal, replacing any TERM", () => {
		const hooked = sanitizeNekoPowerShellEnvironment({ command: "Get-Date", cwd: "/p", env: { Term: "xterm-256color", NODE_ENV: "test" } });
		expect(hooked.command).toBe("if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }\nGet-Date");
		expect(hooked.env).toEqual({ TERM: "dumb" });
	});

	test("both automatic and a chosen PowerShell use it", () => {
		const machine = probe([POWERSHELL, PWSH]);
		for (const setup of [commandShellSetup("auto", machine), commandShellSetup("pwsh", machine)]) {
			expect(setup.toolOptions.powershell?.spawnHook).toBe(sanitizeNekoPowerShellEnvironment);
		}
	});

	// The case reported: pwsh colours table headers and errors even into a pipe.
	test.if(process.platform === "win32" && !!resolveShellExecutable("pwsh"))(
		"pi's powershell tool in automatic mode returns tables and errors without escapes",
		async () => {
			const { createPowerShellToolDefinition } = await import("@earendil-works/pi-coding-agent");
			const tool = createPowerShellToolDefinition(process.cwd(), commandShellSetup("auto").toolOptions.powershell);
			const run = (command: string) =>
				tool.execute("t", { command }, undefined, undefined, undefined as never).then(
					(result) => (result.content[0] as { text: string }).text,
					(error: Error) => error.message,
				);
			const table = await run("Get-Process -Id $PID | Select-Object -First 1 Id, ProcessName");
			expect(table).toContain("ProcessName");
			expect(table).not.toMatch(ANSI);
			const failure = await run("Write-Error 'boom'");
			expect(failure).toContain("boom");
			expect(failure).not.toMatch(ANSI);
		},
		30_000,
	);
});

// Keep `sep` referenced for platforms where join differs; paths above are built with it.
void sep;
