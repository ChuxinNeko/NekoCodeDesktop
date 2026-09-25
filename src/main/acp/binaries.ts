/**
 * Finding the user's own Codex and Claude Code.
 *
 * NekoCode ships the ACP adapters but not the agents: the Codex CLI is a
 * ~440 MB download of its own, and Claude Code's licence does not allow
 * redistributing it. The adapters are told where the installed CLI is through
 * the variable each one reads — `CODEX_PATH`, `CLAUDE_CODE_EXECUTABLE`.
 *
 * A GUI app does not get the login shell's PATH on macOS, and on Windows a CLI
 * installed through npm is a `.cmd` shim that needs Node, so beyond PATH each
 * lookup also knows where the usual installers put the real executable.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type AgentBinary = "codex" | "claude";

export interface ExecutableProbe {
	platform: NodeJS.Platform;
	arch: string;
	env: Record<string, string | undefined>;
	homeDir: string;
	isFile: (path: string) => boolean;
	/** Subdirectories of `path`, newest first. */
	subdirectories: (path: string) => string[];
}

export function nodeProbe(): ExecutableProbe {
	return {
		platform: process.platform,
		arch: process.arch,
		env: process.env,
		homeDir: homedir(),
		isFile: (path) => {
			try {
				return statSync(path).isFile();
			} catch {
				return false;
			}
		},
		subdirectories: (path) => {
			if (!existsSync(path)) return [];
			try {
				return readdirSync(path, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(path, entry.name))
					.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
			} catch {
				return [];
			}
		},
	};
}

function envValue(env: ExecutableProbe["env"], name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
	return key ? env[key] : undefined;
}

function pathDirectories(probe: ExecutableProbe): string[] {
	return (envValue(probe.env, "PATH") ?? "")
		.split(probe.platform === "win32" ? ";" : delimiter)
		.map((entry) => entry.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);
}

/** Directories a GUI launch may be missing from PATH on macOS and Linux. */
function unixExtraDirectories(probe: ExecutableProbe): string[] {
	return [
		join(probe.homeDir, ".local", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(probe.homeDir, ".npm-global", "bin"),
		join(probe.homeDir, ".bun", "bin"),
	];
}

/** The first file among `names` in any PATH directory (plus `extra`), in PATH order. */
export function findOnPath(names: readonly string[], probe: ExecutableProbe, extra: readonly string[] = []): string | undefined {
	for (const directory of [...pathDirectories(probe), ...extra]) {
		for (const name of names) {
			const candidate = join(directory, name);
			if (probe.isFile(candidate)) return candidate;
		}
	}
	return undefined;
}

const WINDOWS_TRIPLES: Record<string, string> = {
	x64: "x86_64-pc-windows-msvc",
	arm64: "aarch64-pc-windows-msvc",
};

/**
 * The native `codex.exe` behind an npm-installed `codex.cmd`. Running it
 * directly needs no Node, which is the point of shipping the adapter.
 */
function codexBehindNpmShim(shimDirectory: string, probe: ExecutableProbe): string | undefined {
	const triple = WINDOWS_TRIPLES[probe.arch];
	if (!triple) return undefined;
	const platformPackage = `codex-win32-${probe.arch}`;
	const roots = [
		join(shimDirectory, "node_modules", "@openai", "codex", "node_modules", "@openai", platformPackage),
		join(shimDirectory, "node_modules", "@openai", platformPackage),
	];
	for (const root of roots) {
		const candidate = join(root, "vendor", triple, "bin", "codex.exe");
		if (probe.isFile(candidate)) return candidate;
	}
	return undefined;
}

export function resolveCodexExecutable(probe: ExecutableProbe): string | undefined {
	if (probe.platform !== "win32") return findOnPath(["codex"], probe, unixExtraDirectories(probe));

	const exe = findOnPath(["codex.exe"], probe);
	if (exe) return exe;
	const shim = findOnPath(["codex.cmd"], probe);
	if (shim) {
		const native = codexBehindNpmShim(shim.slice(0, shim.length - "codex.cmd".length - 1), probe);
		if (native) return native;
	}
	// The Codex desktop app keeps its CLI in a per-version directory.
	const localAppData = envValue(probe.env, "LOCALAPPDATA") ?? join(probe.homeDir, "AppData", "Local");
	for (const directory of probe.subdirectories(join(localAppData, "OpenAI", "Codex", "bin"))) {
		const candidate = join(directory, "codex.exe");
		if (probe.isFile(candidate)) return candidate;
	}
	// Last resort: the shim itself works too, as long as Node is installed.
	return shim;
}

export function resolveClaudeExecutable(probe: ExecutableProbe): string | undefined {
	if (probe.platform !== "win32") {
		return findOnPath(["claude"], probe, [...unixExtraDirectories(probe), join(probe.homeDir, ".claude", "local")]);
	}
	// The SDK spawns this without a shell, so an npm `.cmd` shim cannot stand
	// in for the real executable here.
	return findOnPath(["claude.exe"], probe, [
		join(probe.homeDir, ".local", "bin"),
		join(probe.homeDir, ".claude", "local"),
	]);
}

export function resolveAgentBinary(binary: AgentBinary, probe: ExecutableProbe = nodeProbe()): string | undefined {
	return binary === "codex" ? resolveCodexExecutable(probe) : resolveClaudeExecutable(probe);
}
