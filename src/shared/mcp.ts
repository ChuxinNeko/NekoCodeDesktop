/**
 * How a server is reached.
 *
 * `stdio` is a process this app spawns and talks to over its pipes — what a
 * locally installed server is. `http` is a URL that answers JSON-RPC posts,
 * which is what a hosted one is.
 */
export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
	id: string;
	/** What the user calls it. Also the prefix its tools are namespaced under. */
	name: string;
	transport: McpTransport;
	enabled: boolean;
	/** stdio: the executable and its arguments. */
	command?: string;
	args?: string[];
	/** Added to the inherited environment, not a replacement for it. */
	env?: Record<string, string>;
	/** http: the endpoint that answers JSON-RPC. */
	url?: string;
	headers?: Record<string, string>;
}

export interface McpToolSummary {
	/** The name the server knows it by. */
	name: string;
	/** The namespaced name the model calls, e.g. `mcp__linear__create_issue`. */
	qualifiedName: string;
	description: string;
}

export type McpServerState = "disabled" | "connecting" | "ready" | "error";

export interface McpServerStatus {
	config: McpServerConfig;
	state: McpServerState;
	tools: McpToolSummary[];
	/** Why it is not `ready`. Written for the user, not for a log. */
	error?: string;
}

export interface McpSnapshot {
	servers: McpServerStatus[];
}

/** A new server, or an edit to one. `id` absent means it is being created. */
export interface SaveMcpServerRequest {
	id?: string;
	name: string;
	transport: McpTransport;
	enabled: boolean;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
}

/** Tool names are namespaced so two servers can both offer a `search`. */
export function qualifyToolName(serverName: string, tool: string): string {
	return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}__${tool}`;
}

/**
 * Split a command line the way a shell would.
 *
 * One field rather than separate command and argument inputs, because what
 * people have in hand is a line from a README — `npx -y @scope/server --root
 * "/my files"` — and re-typing it into boxes is where the mistakes come from.
 */
export function splitCommand(line: string): { command: string; args: string[] } {
	const parts = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const unquoted = parts.map((part) =>
		(part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))
			? part.slice(1, -1)
			: part,
	);
	return { command: unquoted[0] ?? "", args: unquoted.slice(1) };
}

/**
 * Parse `KEY=value` lines, used for both environment and headers.
 *
 * A value may itself contain `=` — tokens and base64 routinely do — so only the
 * first one separates. Blank and `#` lines are skipped so a pasted block with
 * comments in it works.
 */
export function parseKeyValueLines(text: string): Record<string, string> {
	const pairs: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const at = trimmed.indexOf("=");
		if (at <= 0) continue;
		pairs[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
	}
	return pairs;
}

export function formatKeyValueLines(pairs: Record<string, string> | undefined): string {
	return Object.entries(pairs ?? {})
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}
