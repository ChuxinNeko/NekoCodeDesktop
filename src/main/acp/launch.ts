/**
 * Turning an agent definition into a process to start.
 *
 * A bundled adapter runs on the Electron binary itself with
 * `ELECTRON_RUN_AS_NODE`, which makes it a plain Node — so NekoCode needs no
 * Node or npx on the user's machine. The flag is removed again before the
 * adapter's code runs: everything the agent starts inherits the environment,
 * and an Electron app launched from there (an editor, `electron-vite dev`)
 * would otherwise come up as Node instead of as itself.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { usesBundledAdapter, usesNativeCli, type AcpAgentDefinition, type BundledAdapter, type NativeAgentCli } from "./agents";
import type { AgentBinary } from "./binaries";

export interface AgentLaunch {
	command: string;
	args: string[];
	env: Record<string, string>;
	/** A user-given command may be a shell script (`npx`); the bundled launch never is. */
	shell: boolean;
}

export interface LaunchContext {
	/** The Electron binary, which doubles as Node. */
	execPath: string;
	/** `app.getAppPath()`: the project root in development, `…/app.asar` when packaged. */
	appRoot: string;
	platform: NodeJS.Platform;
	baseEnv: Record<string, string | undefined>;
	findCli: (binary: AgentBinary) => string | undefined;
	fileExists?: (path: string) => boolean;
}

/** Setting up the agent failed before any process ran: not installed, not found. */
export class AcpSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AcpSetupError";
	}
}

/**
 * Where the adapter lives on disk. Packaged, it is unpacked next to app.asar
 * (see `asarUnpack` in electron-builder.yml): it is loaded by a separate
 * process, which should not depend on reading into the archive.
 */
export function adapterEntryPath(appRoot: string, adapter: BundledAdapter): string {
	const root = appRoot.replace(/app\.asar(?=[\\/]|$)/, "app.asar.unpacked");
	return join(root, "node_modules", ...adapter.packageName.split("/"), ...adapter.entry.split("/"));
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
	return key ? env[key] : undefined;
}

/** Loads the adapter as the main module, minus the flag that made Electron a Node. */
export function bootstrapScript(entry: string): string {
	return [
		"delete process.env.ELECTRON_RUN_AS_NODE;",
		`process.argv.splice(1, 0, ${JSON.stringify(entry)});`,
		`await import(${JSON.stringify(pathToFileURL(entry).href)});`,
	].join("");
}

/**
 * The agent's own CLI, found where its installer puts it. On Windows that may
 * be a `.cmd` shim, which only a shell can run — quoted, since cmd.exe splits
 * an unquoted path at its first space — or a PowerShell script.
 */
export function nativeLaunch(agent: AcpAgentDefinition & { native: NativeAgentCli }, context: LaunchContext): AgentLaunch {
	const native = agent.native;
	const cli = context.findCli(native.binary);
	if (!cli) {
		throw new AcpSetupError(
			`没有在本机找到 ${native.cliName}。请先${native.installHint}；如果已经安装在别处，可以在「设置 → 外部代理」里把 ${agent.name} 的启动命令填成 <可执行文件路径> ${native.args.join(" ")}。`,
		);
	}
	const env = { ...native.env, ...agent.env };
	if (context.platform === "win32" && /\.ps1$/i.test(cli)) {
		return {
			command: "powershell.exe",
			args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cli, ...native.args],
			env,
			shell: false,
		};
	}
	if (context.platform === "win32" && /\.(cmd|bat)$/i.test(cli)) {
		return { command: /\s/.test(cli) ? `"${cli}"` : cli, args: [...native.args], env, shell: true };
	}
	return { command: cli, args: [...native.args], env, shell: false };
}

export function agentLaunch(agent: AcpAgentDefinition, context: LaunchContext): AgentLaunch {
	if (usesNativeCli(agent)) return nativeLaunch(agent, context);
	if (!usesBundledAdapter(agent)) {
		return { command: agent.command, args: [...agent.args], env: { ...agent.env }, shell: context.platform === "win32" };
	}
	const adapter = agent.bundled;
	const entry = adapterEntryPath(context.appRoot, adapter);
	if (!(context.fileExists ?? existsSync)(entry)) {
		throw new AcpSetupError(`内置的 ${adapter.packageName} 缺失（${entry}），请重新安装 NekoCode。`);
	}
	const cli =
		agent.env[adapter.binaryEnv] || envValue(context.baseEnv, adapter.binaryEnv) || context.findCli(adapter.binary);
	if (!cli) {
		throw new AcpSetupError(
			`没有在本机找到 ${adapter.cliName}。请先${adapter.installHint}；如果已经安装在别处，可以在「设置 → 外部代理」里为 ${agent.name} 添加环境变量 ${adapter.binaryEnv}=<可执行文件路径>。`,
		);
	}
	return {
		command: context.execPath,
		args: ["--input-type=module", "-e", bootstrapScript(entry)],
		env: { ...agent.env, ELECTRON_RUN_AS_NODE: "1", [adapter.binaryEnv]: cli },
		shell: false,
	};
}
