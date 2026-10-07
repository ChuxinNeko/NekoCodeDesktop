import { createHash } from "node:crypto";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AuthProvider, McpClient, McpTransport, Tool } from "@earendil-works/pi-mcp";
import type { OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
import {
	qualifyToolName,
	type McpDesktopConnection,
	type McpDesktopViewer,
	type McpServerConfig,
	type McpServerStatus,
	type McpSnapshot,
	type McpToolSummary,
	type SaveMcpServerRequest,
} from "../../shared/mcp";
import { isDesktopBridge, parseDesktopTicket, parseDesktopViewerMetadata, type McpDesktopCapability } from "../../shared/mcp-desktop";
import { piMcp, piMcpOAuth } from "../pi";
import { createMcpAuthProvider, McpSignInRequiredError, signInMcpServer, type McpAuthStore } from "./oauth";
import { McpStore } from "./store";

/** Connecting may start a process that downloads itself first (`npx -y …`). */
const REQUEST_TIMEOUT_MS = 60_000;
/** A tool may legitimately run for a while; progress notifications re-arm this. */
const TOOL_TIMEOUT_MS = 5 * 60_000;
/** How much of a failed stdio server's stderr the settings row shows. */
const STDERR_TAIL = 1_500;

interface Connection {
	client: McpClient;
	transport: McpTransport;
	tools: Tool[];
	config: McpServerConfig;
	authProvider?: AuthProvider;
	desktop?: McpDesktopCapability;
	closed: AbortController;
	openingDesktop?: boolean;
}

export type McpTransportFactory = (
	config: McpServerConfig,
	cwd: string,
	authProvider: AuthProvider | undefined,
) => Promise<McpTransport>;

export interface McpServiceOptions {
	/** Client version sent in the handshake. */
	version?: string;
	/** Where OAuth credentials live; without one, hosted servers that need sign-in cannot connect. */
	auth?: McpAuthStore;
	openUrl?: (url: string) => void | Promise<void>;
	/** Tests hand in their own; the default dials stdio and streamable HTTP. */
	createTransport?: McpTransportFactory;
	/** Metadata/ticket HTTP boundary; separate from the MCP transport. */
	desktopFetch?: typeof globalThis.fetch;
}

/**
 * Owns the configured MCP servers and the tools they contribute.
 *
 * Connections are made once and shared by every session: a server is a process
 * or an endpoint, not a per-conversation resource, and spawning one copy per
 * parallel task would multiply both startup cost and any state the server keeps.
 * The protocol itself — handshake, transports, cancellation, OAuth — is pi-mcp's.
 */
export class McpService {
	private readonly store: McpStore;
	private readonly connections = new Map<string, Connection>();
	private readonly states = new Map<string, { state: McpServerStatus["state"]; error?: string }>();
	private readonly connecting = new Map<string, Promise<void>>();
	/** What each server's last 401 asked for, so sign-in requests the right scope. */
	private readonly challenges = new Map<string, OAuthChallenge>();
	private readonly createTransport: McpTransportFactory;
	private toLlmContent: typeof import("@earendil-works/pi-mcp").toLlmContent | null = null;

	constructor(
		userDataDir: string,
		/** Working directory for stdio servers — the project they act on. */
		private getCwd: () => string,
		private readonly onChange: () => void,
		private readonly options: McpServiceOptions = {},
	) {
		this.store = new McpStore(userDataDir);
		this.createTransport = options.createTransport ?? ((config, cwd, auth) => defaultTransport(config, cwd, auth));
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

	private connect(config: McpServerConfig): Promise<void> {
		const inFlight = this.connecting.get(config.id);
		if (inFlight) return inFlight;

		const attempt = (async () => {
			this.states.set(config.id, { state: "connecting" });
			this.onChange();
			const { McpClient, toLlmContent } = await piMcp();
			this.toLlmContent = toLlmContent;
			let transport: McpTransport;
			const authProvider = this.authProviderFor(config);
			try {
				transport = await this.createTransport(config, this.getCwd(), authProvider);
			} catch (error) {
				this.states.set(config.id, { state: "error", error: message(error) });
				return;
			}
			const client = new McpClient({ name: "NekoCode Desktop", version: this.options.version ?? "1.0.0", requestTimeoutMs: REQUEST_TIMEOUT_MS });
			try {
				await client.connect(transport);
				const tools = await client.listTools();
				if (this.store.list().find(entry => entry.id === config.id) !== config || !config.enabled) {
					await client.close().catch(() => undefined);
					return;
				}
				const connection: Connection = { client, transport, tools, config, authProvider, closed: new AbortController() };
				this.connections.set(config.id, connection);
				this.states.set(config.id, { state: "ready" });
				// A server that crashes or drops mid-session: say so, and let the
				// next call dial it again rather than failing forever.
				client.onClose(() => {
					if (this.connections.get(config.id) !== connection) return;
					this.connections.delete(config.id);
					connection.closed.abort();
					this.states.set(config.id, { state: "error", error: dropReason(transport) });
					this.onChange();
				});
				client.onNotification("notifications/tools/list_changed", () => {
					void client
						.listTools()
						.then((next) => {
							connection.tools = next;
							this.onChange();
						})
						.catch(() => undefined);
				});
				await this.discoverDesktop(config, connection);
			} catch (error) {
				await client.close().catch(() => undefined);
				this.states.set(config.id, await this.failure(config, transport, error));
			}
		})();

		this.connecting.set(config.id, attempt);
		return attempt.finally(() => {
			this.connecting.delete(config.id);
			this.onChange();
		});
	}

	/** Why a connection attempt failed, as the settings row should put it. */
	private async failure(
		config: McpServerConfig,
		transport: McpTransport,
		error: unknown,
	): Promise<{ state: McpServerStatus["state"]; error?: string }> {
		const { McpAuthRequiredError } = await piMcp();
		const { McpOAuthAuthorizationRequiredError } = await piMcpOAuth();
		if (error instanceof McpSignInRequiredError || error instanceof McpOAuthAuthorizationRequiredError ||
			error instanceof McpAuthRequiredError) {
			return usesOAuth(config) && this.options.auth
				? { state: "needs-auth", error: "需要登录" }
				: { state: "error", error: "服务器要求身份验证，请在请求头中填写 Authorization" };
		}
		const stderr = stderrTail(transport);
		return { state: "error", error: stderr ? `${message(error)}\n${stderr}` : message(error) };
	}

	private authProviderFor(config: McpServerConfig): AuthProvider | undefined {
		const auth = this.options.auth;
		if (!auth || !usesOAuth(config) || !config.url) return undefined;
		const serverUrl = config.url;
		return createMcpAuthProvider({
			serverUrl,
			store: auth,
			onChallenge: (challenge) => this.challenges.set(config.id, challenge),
		});
	}

	private disconnect(id: string): void {
		const connection = this.connections.get(id);
		if (!connection) return;
		this.connections.delete(id);
		connection.closed.abort();
		void connection.client.close().catch(() => undefined);
	}

	snapshot(): McpSnapshot {
		return {
			servers: this.store.list().map((config) => {
				const recorded = this.states.get(config.id);
				const state = config.enabled ? (recorded?.state ?? "connecting") : "disabled";
				const oauth = usesOAuth(config) && !!this.options.auth && !!config.url;
				const desktop = this.connections.get(config.id)?.desktop;
				const signedIn = oauth && this.options.auth!.signedIn(config.url!);
				return {
					config,
					state,
					error: recorded?.error,
					tools: this.summaries(config),
					...(oauth ? { signedIn: !!signedIn } : {}),
					...(config.enabled && state === "ready" && signedIn && desktop ? {
						desktopViewer: { url: desktop.url, partition: desktop.partition, readOnly: true as const },
					} : {}),
				};
			}),
		};
	}

	/** The guest allowlist contains public URLs, never the one-use fragment. */
	desktopViewers(): McpDesktopViewer[] {
		return this.snapshot().servers.flatMap(server => server.desktopViewer ? [server.desktopViewer] : []);
	}

	private async discoverDesktop(config: McpServerConfig, connection: Connection): Promise<void> {
		if (!connection.authProvider || !config.url || !isDesktopBridge(connection.client.serverInfo?.name, connection.tools)) return;
		try {
			let capability = parseDesktopViewerMetadata(config.url, this.options.auth?.load(config.url)?.discovery?.resourceMetadata);
			if (!capability) {
				const url = new URL(config.url);
				if (url.username || url.password || url.search || url.hash) return;
				const paths = new Set([`/.well-known/oauth-protected-resource${url.pathname.replace(/\/$/, "")}`, "/.well-known/oauth-protected-resource"]);
				for (const path of paths) {
					const response = await (this.options.desktopFetch ?? globalThis.fetch)(new URL(path, url.origin), {
						redirect: "error", signal: AbortSignal.any([connection.closed.signal, AbortSignal.timeout(5000)]),
					});
					if (!response.ok) { await response.body?.cancel(); continue; }
					capability = parseDesktopViewerMetadata(config.url, await response.json());
					if (capability) break;
				}
			}
			if (capability && this.connections.get(config.id) === connection && this.store.list().find(entry => entry.id === config.id) === config) {
				connection.desktop = {
					...capability,
					partition: `persist:nekocode-mcp-desktop-${createHash("sha256").update(JSON.stringify([config.id, capability.url])).digest("hex")}`,
				};
			}
		} catch {
			// Optional capability failures must not break a working MCP connection.
		}
	}

	/** Only the trusted renderer may request a ticket; this is not an agent tool. */
	async openDesktop(id: string): Promise<McpDesktopConnection> {
		const connection = this.connections.get(id);
		const config = this.store.list().find(entry => entry.id === id);
		const desktop = connection?.desktop;
		if (!connection || !config?.enabled || connection.config !== config || !config.url || !desktop ||
			!connection.authProvider || this.states.get(id)?.state !== "ready" || !this.options.auth?.signedIn(config.url)) {
			throw new Error("MCP 桌面不可用，请确认服务器已连接并完成 OAuth 登录");
		}
		if (connection.openingDesktop) throw new Error("桌面连接正在建立，请稍后重试");
		connection.openingDesktop = true;
		const current = () => this.connections.get(id) === connection &&
			this.store.list().find(entry => entry.id === id) === config && config.enabled && !!this.options.auth?.signedIn(config.url!);
		const needsAuth = () => {
			if (current()) {
				this.disconnect(id);
				this.states.set(id, { state: "needs-auth", error: "需要登录" });
				this.onChange();
			}
			return new McpSignInRequiredError();
		};
		const fetch = this.options.desktopFetch ?? globalThis.fetch;
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const token = await connection.authProvider.token();
				if (!current()) throw new Error("桌面来源已改变");
				if (!token) throw needsAuth();
				const response = await fetch(desktop.ticketEndpoint, {
					method: "POST", headers: { Authorization: `Bearer ${token}` }, redirect: "error",
					signal: AbortSignal.any([connection.closed.signal, AbortSignal.timeout(15000)]),
				});
				if (!current()) { await response.body?.cancel(); throw new Error("桌面来源已改变"); }
				if (response.status === 401 || response.status === 403 && response.headers.get("www-authenticate")?.includes("insufficient_scope")) {
					try {
						if (attempt || !connection.authProvider.onUnauthorized) throw needsAuth();
						await connection.authProvider.onUnauthorized({ response, serverUrl: new URL(config.url), fetch, token });
					} catch { throw needsAuth(); }
					finally { await response.body?.cancel(); }
					continue;
				}
				if (!response.ok) { await response.body?.cancel(); throw new Error("桌面授权被拒绝"); }
				const viewerUrl = parseDesktopTicket(desktop, await response.json());
				if (!viewerUrl || !current()) throw new Error("无效桌面连接");
				return { serverId: id, viewerUrl, partition: desktop.partition };
			}
			throw needsAuth();
		} catch (error) {
			if (error instanceof McpSignInRequiredError) throw error;
			// Neither response text nor a URL containing a ticket may enter logs/IPC errors.
			throw new Error("无法打开 MCP 桌面，请重试；若授权已失效，请在 MCP 设置中重新登录");
		} finally { connection.openingDesktop = false; }
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
					label: `${config.name}/${tool.title ?? tool.name}`,
					description: tool.description ?? `${config.name} 提供的 ${tool.name} 工具`,
					parameters: toParameterSchema(tool.inputSchema) as unknown as TSchema,
					execute: (_id, params, signal) => this.call(config.id, tool.name, qualified, params, signal),
				} as ToolDefinition);
			}
		}
		return definitions;
	}

	private async call(
		id: string,
		tool: string,
		qualified: string,
		params: unknown,
		signal: AbortSignal | undefined,
	) {
		let connection = this.connections.get(id);
		if (!connection) {
			// Dropped since the session was given the tool: dial once more.
			const config = this.store.list().find((entry) => entry.id === id);
			if (config?.enabled && this.states.get(id)?.state !== "needs-auth") await this.connect(config);
			connection = this.connections.get(id);
		}
		if (!connection) throw new Error(this.states.get(id)?.error ?? `${qualified} 所在的 MCP 服务器未连接`);
		const config = this.store.list().find((entry) => entry.id === id);
		const result = await connection.client.callTool(tool, (params ?? {}) as Record<string, unknown>, {
			signal,
			timeoutMs: TOOL_TIMEOUT_MS,
			// Any progress at all counts as the tool being alive.
			onProgress: () => undefined,
		});
		const content = this.toLlmContent?.(result) ?? [];
		const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
		// A server reporting failure has to throw: a result the agent reads as
		// success would have it build on an error message.
		if (result.isError) throw new Error(text || `${qualified} 调用失败`);
		return {
			content: content.length > 0 ? content : [{ type: "text" as const, text: "(no output)" }],
			details: { server: config?.name ?? id, tool },
		};
	}

	async save(request: SaveMcpServerRequest): Promise<McpSnapshot> {
		const config = this.store.put(request);
		// Reconnect unconditionally on save: the edit may have changed the command
		// or the URL, and a live connection to the old one would be a lie.
		this.disconnect(config.id);
		this.states.delete(config.id);
		await this.connecting.get(config.id);
		await this.refresh();
		return this.snapshot();
	}

	async remove(id: string): Promise<McpSnapshot> {
		this.disconnect(id);
		this.states.delete(id);
		this.challenges.delete(id);
		this.store.remove(id);
		this.onChange();
		return this.snapshot();
	}

	/** Drop and redial one server — the settings panel's retry. */
	async reconnect(id: string): Promise<McpSnapshot> {
		this.disconnect(id);
		this.states.delete(id);
		await this.connecting.get(id);
		await this.refresh();
		return this.snapshot();
	}

	/** Sign in through the browser, then connect with what it granted. */
	async signIn(id: string): Promise<McpSnapshot> {
		const config = this.store.list().find((entry) => entry.id === id);
		if (!config?.url || !usesOAuth(config)) throw new Error("该服务器不使用 OAuth 登录");
		const auth = this.options.auth;
		const openUrl = this.options.openUrl;
		if (!auth || !openUrl) throw new Error("当前环境不支持 MCP 登录");
		await signInMcpServer({ serverUrl: config.url, store: auth, challenge: this.challenges.get(id), openUrl });
		this.challenges.delete(id);
		return this.reconnect(id);
	}

	/** Forget the server's tokens; it goes back to needing a sign-in. */
	async signOut(id: string): Promise<McpSnapshot> {
		const config = this.store.list().find((entry) => entry.id === id);
		if (config?.url) this.options.auth?.remove(config.url);
		return this.reconnect(id);
	}

	close(): void {
		for (const [id] of this.connections) this.disconnect(id);
	}
}

async function defaultTransport(
	config: McpServerConfig,
	cwd: string,
	authProvider: AuthProvider | undefined,
): Promise<McpTransport> {
	const { StdioTransport, StreamableHttpTransport } = await piMcp();
	if (config.transport === "stdio") {
		if (!config.command) throw new Error("缺少启动命令");
		// cross-spawn underneath: `npx` and other `.cmd` shims resolve on Windows
		// without a shell, and closing takes the whole process tree down.
		return new StdioTransport({
			command: config.command,
			args: config.args ?? [],
			env: config.env ?? {},
			cwd,
			stderr: "pipe",
		});
	}
	if (!config.url) throw new Error("缺少服务器地址");
	return new StreamableHttpTransport({ url: config.url, headers: config.headers ?? {}, authProvider });
}

/** Hosted servers sign in with OAuth unless the user supplied their own `Authorization`. */
export function usesOAuth(config: McpServerConfig): boolean {
	if (config.transport !== "http") return false;
	return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

/**
 * Coerce a server's declared schema into something the agent core can validate.
 *
 * TypeBox schemas are plain JSON Schema at runtime, so a well-formed
 * `inputSchema` passes straight through. A server that sends something that is
 * not an object schema gets an empty one — the tool stays callable with no
 * arguments rather than disappearing.
 */
export function toParameterSchema(inputSchema: unknown): Record<string, unknown> {
	if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
		return { type: "object", properties: {} };
	}
	const schema = { ...(inputSchema as Record<string, unknown>) };
	if (schema.type !== "object") return { type: "object", properties: {} };
	if (typeof schema.properties !== "object" || !schema.properties) schema.properties = {};
	return schema;
}

function stderrTail(transport: McpTransport): string {
	const stderr = (transport as { stderr?: unknown }).stderr;
	return typeof stderr === "string" ? stderr.trim().slice(-STDERR_TAIL) : "";
}

function dropReason(transport: McpTransport): string {
	return stderrTail(transport) || "连接已断开，下次调用时会自动重连";
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
