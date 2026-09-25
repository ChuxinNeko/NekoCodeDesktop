import { describe, expect, test } from "bun:test";
import { join, sep } from "node:path";
import { BUILTIN_ACP_AGENTS, acpAgentInfo, type AcpAgentDefinition } from "./agents";
import { findOnPath, resolveClaudeExecutable, resolveCodexExecutable, type ExecutableProbe } from "./binaries";
import { AcpSetupError, adapterEntryPath, agentLaunch, bootstrapScript, type LaunchContext } from "./launch";

const HOME = join("C:", "Users", "neko");
const NPM = join(HOME, "AppData", "Roaming", "npm");
const LOCAL = join(HOME, "AppData", "Local");

function probe(files: string[], overrides: Partial<ExecutableProbe> = {}): ExecutableProbe {
	const set = new Set(files);
	return {
		platform: "win32",
		arch: "x64",
		env: { Path: [join("C:", "Windows"), NPM].join(";"), LOCALAPPDATA: LOCAL },
		homeDir: HOME,
		isFile: (path) => set.has(path),
		subdirectories: (path) => {
			const children = new Set<string>();
			for (const file of set) {
				if (!file.startsWith(path + sep)) continue;
				const rest = file.slice(path.length + 1).split(/[\\/]/);
				if (rest.length > 1) children.add(join(path, rest[0]));
			}
			return [...children].sort().reverse();
		},
		...overrides,
	};
}

const codex = BUILTIN_ACP_AGENTS.find((agent) => agent.id === "codex")!;
const claude = BUILTIN_ACP_AGENTS.find((agent) => agent.id === "claude")!;

describe("finding the user's CLI", () => {
	test("prefers the native codex.exe behind an npm shim over the shim itself", () => {
		const native = join(NPM, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
		expect(resolveCodexExecutable(probe([join(NPM, "codex.cmd"), native]))).toBe(native);
		// Without the native binary the shim is still usable, given Node.
		expect(resolveCodexExecutable(probe([join(NPM, "codex.cmd")]))).toBe(join(NPM, "codex.cmd"));
	});

	test("falls back to the Codex desktop app's newest CLI", () => {
		const older = join(LOCAL, "OpenAI", "Codex", "bin", "aaa", "codex.exe");
		const newer = join(LOCAL, "OpenAI", "Codex", "bin", "bbb", "codex.exe");
		expect(resolveCodexExecutable(probe([older, newer]))).toBe(newer);
	});

	test("finds Claude Code's native installer, never an npm .cmd shim", () => {
		const native = join(HOME, ".local", "bin", "claude.exe");
		expect(resolveClaudeExecutable(probe([native, join(NPM, "claude.cmd")]))).toBe(native);
		expect(resolveClaudeExecutable(probe([join(NPM, "claude.cmd")]))).toBeUndefined();
	});

	test("reads PATH whatever its case, in order", () => {
		const first = join("C:", "Windows", "codex.exe");
		expect(findOnPath(["codex.exe"], probe([first, join(NPM, "codex.exe")]))).toBe(first);
		expect(findOnPath(["codex.exe"], probe([], { env: {} }))).toBeUndefined();
	});
});

describe("agentLaunch", () => {
	const context = (overrides: Partial<LaunchContext> = {}): LaunchContext => ({
		execPath: join("C:", "Program Files", "NekoCode", "NekoCode.exe"),
		appRoot: join("C:", "Program Files", "NekoCode", "resources", "app.asar"),
		platform: "win32",
		baseEnv: {},
		findCli: () => join(HOME, "codex.exe"),
		fileExists: () => true,
		...overrides,
	});

	test("runs the bundled adapter on Electron as Node, pointed at the user's CLI", () => {
		const launch = agentLaunch(codex, context());
		expect(launch.command).toBe(join("C:", "Program Files", "NekoCode", "NekoCode.exe"));
		expect(launch.shell).toBe(false);
		expect(launch.args.slice(0, 2)).toEqual(["--input-type=module", "-e"]);
		expect(launch.args[2]).toContain("delete process.env.ELECTRON_RUN_AS_NODE");
		expect(launch.args[2]).toContain("app.asar.unpacked");
		expect(launch.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1", CODEX_PATH: join(HOME, "codex.exe") });
	});

	test("a CLI path the user set wins over discovery", () => {
		const custom: AcpAgentDefinition = { ...codex, env: { CODEX_PATH: "D:/tools/codex.exe" } };
		expect(agentLaunch(custom, context()).env.CODEX_PATH).toBe("D:/tools/codex.exe");
		expect(agentLaunch(codex, context({ baseEnv: { codex_path: "E:/codex.exe" } })).env.CODEX_PATH).toBe("E:/codex.exe");
	});

	test("says how to install the CLI when it is missing", () => {
		expect(() => agentLaunch(claude, context({ findCli: () => undefined }))).toThrow(AcpSetupError);
		expect(() => agentLaunch(claude, context({ findCli: () => undefined }))).toThrow("CLAUDE_CODE_EXECUTABLE");
	});

	test("a missing bundled adapter is reported, not spawned", () => {
		expect(() => agentLaunch(codex, context({ fileExists: () => false }))).toThrow("缺失");
	});

	test("a command of the user's own is run as given, through a shell on Windows", () => {
		const custom: AcpAgentDefinition = { ...codex, command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] };
		expect(agentLaunch(custom, context())).toEqual({
			command: "npx",
			args: ["-y", "@agentclientprotocol/codex-acp"],
			env: {},
			shell: true,
		});
	});

	test("the adapter is loaded from the unpacked copy next to app.asar", () => {
		const entry = adapterEntryPath(join("C:", "App", "resources", "app.asar"), codex.bundled!);
		expect(entry).toBe(join("C:", "App", "resources", "app.asar.unpacked", "node_modules", "@agentclientprotocol", "codex-acp", "dist", "index.js"));
		// In development the project root is used as is.
		expect(adapterEntryPath(join("D:", "work", "NekoCode"), codex.bundled!)).toContain(join("D:", "work", "NekoCode", "node_modules"));
		expect(bootstrapScript(entry)).toContain("file:///");
	});
});

describe("acpAgentInfo", () => {
	test("reports the bundled adapter and where the CLI was found", () => {
		expect(acpAgentInfo(codex, () => "C:/codex.exe").bundled).toMatchObject({
			adapter: "codex-acp 1.13.1",
			cliName: "Codex CLI",
			cliPath: "C:/codex.exe",
		});
		expect(acpAgentInfo(claude, () => undefined).bundled?.cliPath).toBeNull();
		// A built-in agent given a command of its own no longer uses the adapter.
		expect(acpAgentInfo({ ...codex, command: "npx", args: ["x"] }).bundled).toBeUndefined();
		expect(acpAgentInfo({ ...codex, command: "npx", args: ["x"] }).commandLine).toBe("npx x");
	});
});
