import type { AcpAgentConfig, AcpAgentInfo } from "../../shared/acp";
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
 * How to launch an ACP agent. A built-in agent runs its bundled adapter unless
 * the user gave it a command of their own; a custom agent always has one.
 */
export interface AcpAgentDefinition extends AcpAgentConfig {
	description: string;
	builtin: boolean;
	bundled?: BundledAdapter;
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
];

/** A built-in agent the user has not given a command of their own. */
export function usesBundledAdapter(agent: AcpAgentDefinition): agent is AcpAgentDefinition & { bundled: BundledAdapter } {
	return !!agent.bundled && !agent.command.trim();
}

export function acpAgentInfo(agent: AcpAgentDefinition, findCli: (binary: AgentBinary) => string | undefined = () => undefined): AcpAgentInfo {
	const { bundled, ...config } = agent;
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
