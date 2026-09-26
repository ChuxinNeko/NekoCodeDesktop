import type { AcpAgentConfig, AcpAgentInfo } from "../../shared/acp";
import { CURSOR_AUTH, DEVIN_AUTH, DROID_AUTH, GROK_AUTH, type AcpAuthPlan } from "./auth";
import type { AgentBinary } from "./binaries";

/**
 * An ACP adapter that ships inside NekoCode as a dependency. It runs on
 * Electron's own Node, so a user needs neither Node nor npx — only the agent's
 * CLI, which the adapter is pointed at through `binaryEnv`.
 */
export interface BundledAdapter {
	/** The npm package, resolved from NekoCode's own node_modules. */
	packageName: string;
	version: string;
	/** The adapter's entry script inside the package. */
	entry: string;
	binary: AgentBinary;
	/** The variable the adapter reads for the CLI's location. */
	binaryEnv: string;
	cliName: string;
	installHint: string;
}

/**
 * An agent whose own CLI speaks ACP, so NekoCode starts it directly — found on
 * this machine the same way the bundled adapters find theirs.
 */
export interface NativeAgentCli {
	binary: AgentBinary;
	/** What puts the CLI in ACP mode over stdio, e.g. `["acp"]`. */
	args: string[];
	/** Environment the CLI needs to run headless; the user's own entries win. */
	env?: Record<string, string>;
	cliName: string;
	installHint: string;
	/** How to sign in before a session opens. Applies to a user-given command too. */
	auth?: AcpAuthPlan;
}

/**
 * How to launch an ACP agent. A built-in agent runs its bundled adapter or its
 * own CLI unless the user gave it a command of their own; a custom agent
 * always has one.
 */
export interface AcpAgentDefinition extends AcpAgentConfig {
	description: string;
	builtin: boolean;
	bundled?: BundledAdapter;
	native?: NativeAgentCli;
}

/**
 * Adapter versions are pinned in package.json, so an adapter release cannot
 * change behaviour under a user who did nothing.
 */
export const BUILTIN_ACP_AGENTS: readonly AcpAgentDefinition[] = [
	{
		id: "codex",
		name: "Codex",
		description: "OpenAI Codex，通过内置的 codex-acp 适配器接入，使用本机 Codex 的登录与配置",
		command: "",
		args: [],
		env: {},
		enabled: true,
		builtin: true,
		bundled: {
			packageName: "@agentclientprotocol/codex-acp",
			version: "1.13.1",
			entry: "dist/index.js",
			binary: "codex",
			binaryEnv: "CODEX_PATH",
			cliName: "Codex CLI",
			installHint: "安装 Codex 桌面版，或运行 npm i -g @openai/codex，然后执行 codex login 登录",
		},
	},
	{
		id: "claude",
		name: "Claude Agent",
		description: "Anthropic Claude Code，通过内置的 claude-agent-acp 适配器接入，使用本机 Claude Code 的登录与配置",
		command: "",
		args: [],
		env: {},
		enabled: false,
		builtin: true,
		bundled: {
			packageName: "@agentclientprotocol/claude-agent-acp",
			version: "0.81.1",
			entry: "dist/index.js",
			binary: "claude",
			binaryEnv: "CLAUDE_CODE_EXECUTABLE",
			cliName: "Claude Code",
			installHint: "按 https://code.claude.com 的说明安装 Claude Code（原生安装器），然后运行 claude 登录",
		},
	},
	{
		id: "cursor",
		name: "Cursor",
		description: "Cursor Agent，以 cursor-agent acp 直接接入，使用本机 Cursor 的登录与订阅",
		command: "",
		args: [],
		env: {},
		enabled: false,
		builtin: true,
		native: {
			binary: "cursor",
			args: ["acp"],
			// Sign-in must never open a browser behind the user's back.
			env: { NO_BROWSER: "true", BROWSER: "www-browser" },
			cliName: "Cursor Agent CLI",
			installHint: "按 https://cursor.com/cli 的说明安装 Cursor CLI，然后运行 cursor-agent login 登录",
			auth: CURSOR_AUTH,
		},
	},
	{
		id: "grok",
		name: "Grok",
		description: "xAI Grok，以 grok agent stdio 直接接入，使用本机 Grok CLI 的登录或 XAI_API_KEY",
		command: "",
		args: [],
		env: {},
		enabled: false,
		builtin: true,
		native: {
			binary: "grok",
			// `default` keeps every action behind an ACP permission request.
			args: ["--permission-mode", "default", "agent", "--no-leader", "stdio"],
			cliName: "Grok CLI",
			installHint: "安装 Grok CLI，然后运行 grok login 登录，或为 Grok 设置环境变量 XAI_API_KEY",
			auth: GROK_AUTH,
		},
	},
	{
		id: "droid",
		name: "Droid",
		description: "Factory Droid，以 droid exec --output-format acp 直接接入，使用本机 Droid 的登录或 FACTORY_API_KEY",
		command: "",
		args: [],
		env: {},
		enabled: false,
		builtin: true,
		native: {
			binary: "droid",
			args: ["exec", "--output-format", "acp"],
			cliName: "Droid CLI",
			installHint: "按 https://factory.ai 的说明安装 Droid CLI，然后运行 droid 完成登录，或设置环境变量 FACTORY_API_KEY",
			auth: DROID_AUTH,
		},
	},
	{
		id: "devin",
		name: "Devin",
		description: "Cognition Devin，以 devin acp 直接接入，使用本机 Devin CLI 的登录或 WINDSURF_API_KEY",
		command: "",
		args: [],
		env: {},
		enabled: false,
		builtin: true,
		native: {
			binary: "devin",
			args: ["acp"],
			cliName: "Devin CLI",
			installHint: "安装 Devin CLI，然后运行 devin auth login 登录，或设置环境变量 WINDSURF_API_KEY",
			auth: DEVIN_AUTH,
		},
	},
];

/** A built-in agent the user has not given a command of their own. */
export function usesBundledAdapter(agent: AcpAgentDefinition): agent is AcpAgentDefinition & { bundled: BundledAdapter } {
	return !!agent.bundled && !agent.command.trim();
}

/** A built-in agent started through its own CLI, found on this machine. */
export function usesNativeCli(agent: AcpAgentDefinition): agent is AcpAgentDefinition & { native: NativeAgentCli } {
	return !!agent.native && !agent.command.trim();
}

export function acpAgentInfo(agent: AcpAgentDefinition, findCli: (binary: AgentBinary) => string | undefined = () => undefined): AcpAgentInfo {
	// Neither goes over IPC: the auth plan holds functions.
	const { bundled, native, ...config } = agent;
	return {
		...config,
		args: [...agent.args],
		env: { ...agent.env },
		commandLine: agent.command.trim() ? [agent.command, ...agent.args].join(" ") : "",
		...(bundled && usesBundledAdapter(agent)
			? {
					bundled: {
						adapter: `${bundled.packageName.split("/").pop()} ${bundled.version}`,
						cliName: bundled.cliName,
						cliPath: agent.env[bundled.binaryEnv] ?? findCli(bundled.binary) ?? null,
						installHint: bundled.installHint,
					},
				}
			: {}),
		...(native && usesNativeCli(agent)
			? {
					native: {
						invocation: native.args.join(" "),
						cliName: native.cliName,
						cliPath: findCli(native.binary) ?? null,
						installHint: native.installHint,
					},
				}
			: {}),
	};
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * Proxy variables for an agent process, from the proxy NekoCode resolved.
 *
 * Agents are separate programs and do not inherit the main process's proxy.
 * Codex is the case in point: its HTTPS client follows the Windows system
 * proxy but its WebSocket client does not, so on a network that needs a proxy
 * every turn opens with "tls handshake eof" and a fall back to HTTPS. The
 * standard variables reach both. Variables the user set themselves win.
 *
 * Loopback is exempted always, proxy or not: Codex applies the system proxy to
 * `127.0.0.1` as well, and NekoCode's own tool server lives there — through a
 * proxy the agent's MCP handshake fails with a 502 from the proxy.
 */
export function agentProxyEnv(
	proxyUrl: string | undefined,
	baseEnv: Record<string, string | undefined>,
): Record<string, string> {
	const has = (name: string) => Object.keys(baseEnv).some((key) => key.toUpperCase() === name && !!baseEnv[key]);
	const env: Record<string, string> = {};
	if (proxyUrl) {
		for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) {
			if (!has(name)) env[name] = proxyUrl;
		}
	}
	const noProxyKey = Object.keys(baseEnv).find((key) => key.toUpperCase() === "NO_PROXY");
	const existing = (noProxyKey ? baseEnv[noProxyKey] : undefined)?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
	env[noProxyKey ?? "NO_PROXY"] = [...new Set([...existing, ...LOCAL_HOSTS])].join(",");
	return env;
}
