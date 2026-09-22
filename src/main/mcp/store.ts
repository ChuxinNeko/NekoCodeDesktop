import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig, SaveMcpServerRequest } from "../../shared/mcp";

const FILE = "mcp-servers.json";
const MAX_SERVERS = 50;

interface ServersFile {
	version: 1;
	servers: McpServerConfig[];
}

/** Persistence for the configured MCP servers. */
export class McpStore {
	private readonly path: string;
	private servers: McpServerConfig[] | null = null;

	constructor(userDataDir: string) {
		mkdirSync(userDataDir, { recursive: true });
		this.path = join(userDataDir, FILE);
	}

	list(): McpServerConfig[] {
		if (this.servers) return this.servers;
		if (!existsSync(this.path)) {
			this.servers = [];
			return this.servers;
		}
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as ServersFile;
			this.servers = Array.isArray(parsed.servers) ? parsed.servers.filter(isConfig) : [];
		} catch (error) {
			// Refusing to start would lock the user out of the settings page that
			// is the only place to fix it.
			throw new Error(
				`mcp-servers.json 已损坏，请修复或删除后重试：${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return this.servers;
	}

	private save(): void {
		const file: ServersFile = { version: 1, servers: this.list() };
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
		renameSync(temporary, this.path);
	}

	/** Create or update. Returns the stored record, id assigned on create. */
	put(request: SaveMcpServerRequest): McpServerConfig {
		const servers = this.list();
		const name = request.name.trim();
		if (!name) throw new Error("请填写服务器名称");
		if (request.transport === "stdio" && !request.command?.trim()) {
			throw new Error("stdio 服务器需要填写启动命令");
		}
		if (request.transport === "http" && !request.url?.trim()) {
			throw new Error("http 服务器需要填写地址");
		}
		if (request.transport === "http" && request.url && !/^https?:\/\//i.test(request.url.trim())) {
			throw new Error("地址必须以 http:// 或 https:// 开头");
		}

		const config: McpServerConfig = {
			id: request.id ?? randomUUID(),
			name,
			transport: request.transport,
			enabled: request.enabled,
			...(request.transport === "stdio"
				? { command: request.command?.trim(), args: request.args ?? [], env: request.env ?? {} }
				: { url: request.url?.trim(), headers: request.headers ?? {} }),
		};

		const at = servers.findIndex((entry) => entry.id === config.id);
		if (at === -1) {
			if (servers.length >= MAX_SERVERS) throw new Error("配置的 MCP 服务器过多");
			servers.push(config);
		} else {
			servers[at] = config;
		}
		this.save();
		return config;
	}

	remove(id: string): void {
		this.servers = this.list().filter((entry) => entry.id !== id);
		this.save();
	}
}

function isConfig(value: unknown): value is McpServerConfig {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<McpServerConfig>;
	return (
		typeof entry.id === "string" &&
		typeof entry.name === "string" &&
		(entry.transport === "stdio" || entry.transport === "http")
	);
}
