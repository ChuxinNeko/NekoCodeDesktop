import type { TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	qualifyToolName,
	type McpServerConfig,
	type McpServerStatus,
	type McpSnapshot,
	type McpToolSummary,
	type SaveMcpServerRequest,
} from "../../shared/mcp";
import { McpClient } from "./client";
import { resultText, toParameterSchema, type McpToolDescriptor } from "./protocol";
import { McpStore } from "./store";
import { HttpTransport, StdioTransport, type McpTransport } from "./transport";

interface Connection {
	client: McpClient;
	tools: McpToolDescriptor[];
}

/**
 * Owns the configured MCP servers and the tools they contribute.
 *
 * Connections are made once and shared by every session: a server is a process
 * or an endpoint, not a per-conversation resource, and spawning one copy per
 * parallel task would multiply both startup cost and any state the server keeps.
 */
export class McpService {
	private readonly store: McpStore;
	private readonly connections = new Map<string, Connection>();
	private readonly states = new Map<string, { state: McpServerStatus["state"]; error?: string }>();
	private connecting = new Map<string, Promise<void>>();

	constructor(
		userDataDir: string,
		/** Working directory for stdio servers — the project they act on. */
		private getCwd: () => string,
		private readonly onChange: () => void,
	) {
		this.store = new McpStore(userDataDir);
	}

	/**
	 * Bring every enabled server up.
	 *
	 * Failures are recorded rather than thrown: one broken server must not stop
	 * the others, and the settings panel is where its error belongs.
	 */
	async refresh(): Promise<void> {
		const configs = this.store.list();
		for (const [id] of this.connections) {
			if (!configs.some((config) => config.id === id && config.enabled)) this.disconnect(id);
		}
		await Promise.all(
			configs.map(async (config) => {
				if (!config.enabled) {
					this.disconnect(config.id);
					this.states.set(config.id, { state: "disabled" });
					return;
				}
				if (this.connections.has(config.id)) return;
				await this.connect(config);
			}),
		);
		this.onChange();
	}

	private async connect(config: McpServerConfig): Promise<void> {
		const inFlight = this.connecting.get(config.id);
		if (inFlight) return inFlight;

		const attempt = (async () => {
			this.states.set(config.id, { state: "connecting" });
			this.onChange();
			let transport: McpTransport;
			try {
				transport = this.makeTransport(config);
			} catch (error) {
				this.states.set(config.id, { state: "error", error: message(error) });
				return;
			}
			const client = new McpClient(transport);
			try {
				await client.connect("NekoCode Desktop");
				const tools = await client.listTools();
				this.connections.set(config.id, { client, tools });
				this.states.set(config.id, { state: "ready" });
			} catch (error) {
				client.close();
				this.states.set(config.id, { state: "error", error: message(error) });
			}
		})();

		this.connecting.set(config.id, attempt);
		try {
			await attempt;
		} finally {
			this.connecting.delete(config.id);
			this.onChange();
		}
	}

	private makeTransport(config: McpServerConfig): McpTransport {
		if (config.transport === "stdio") {
			if (!config.command) throw new Error("缺少启动命令");
			return new StdioTransport({
				command: config.command,
				args: config.args ?? [],
				env: config.env ?? {},
				cwd: this.getCwd(),
			});
		}
		if (!config.url) throw new Error("缺少服务器地址");
		return new HttpTransport({ url: config.url, headers: config.headers ?? {} });
	}

	private disconnect(id: string): void {
		const connection = this.connections.get(id);
		if (!connection) return;
		this.connections.delete(id);
		connection.client.close();
	}

	snapshot(): McpSnapshot {
		return {
			servers: this.store.list().map((config) => {
				const recorded = this.states.get(config.id);
				const state = config.enabled ? (recorded?.state ?? "connecting") : "disabled";
				return {
					config,
					state,
					error: recorded?.error,
					tools: this.summaries(config),
				};
			}),
		};
	}

	private summaries(config: McpServerConfig): McpToolSummary[] {
		const connection = this.connections.get(config.id);
		if (!connection) return [];
		return connection.tools.map((tool) => ({
			name: tool.name,
			qualifiedName: qualifyToolName(config.name, tool.name),
			description: tool.description ?? "",
		}));
	}

	/** Names the mode manifest has to allow, or the agent rejects every call. */
	toolNames(): string[] {
		return this.tools().map((tool) => tool.name);
	}

	/**
	 * The connected servers' tools, as the agent core takes them.
	 *
	 * Built fresh on every session start so a server connected since the last
	 * one is picked up. A server that is down contributes nothing rather than a
	 * tool that always fails — the model should not be offered what cannot run.
	 */
	tools(): ToolDefinition[] {
		const definitions: ToolDefinition[] = [];
		for (const config of this.store.list()) {
			const connection = this.connections.get(config.id);
			if (!connection) continue;
			for (const tool of connection.tools) {
				const qualified = qualifyToolName(config.name, tool.name);
				definitions.push({
					name: qualified,
					label: `${config.name}/${tool.name}`,
					description: tool.description ?? `${config.name} 提供的 ${tool.name} 工具`,
					parameters: toParameterSchema(tool.inputSchema) as unknown as TSchema,
					async execute(_id, params, signal) {
						const result = await connection.client.callTool(tool.name, params, signal);
						const text = resultText(result);
						// A server reporting failure has to throw: a result the agent
						// reads as success would have it build on an error message.
						if (result.isError) throw new Error(text || `${qualified} 调用失败`);
						return {
							content: [{ type: "text", text: text || "(no output)" }],
							details: { server: config.name, tool: tool.name },
						};
					},
				} as ToolDefinition);
			}
		}
		return definitions;
	}

	async save(request: SaveMcpServerRequest): Promise<McpSnapshot> {
		const config = this.store.put(request);
		// Reconnect unconditionally on save: the edit may have changed the command
		// or the URL, and a live connection to the old one would be a lie.
		this.disconnect(config.id);
		this.states.delete(config.id);
		await this.refresh();
		return this.snapshot();
	}

	async remove(id: string): Promise<McpSnapshot> {
		this.disconnect(id);
		this.states.delete(id);
		this.store.remove(id);
		this.onChange();
		return this.snapshot();
	}

	/** Drop and redial one server — the settings panel's retry. */
	async reconnect(id: string): Promise<McpSnapshot> {
		this.disconnect(id);
		this.states.delete(id);
		await this.refresh();
		return this.snapshot();
	}

	close(): void {
		for (const [id] of this.connections) this.disconnect(id);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
