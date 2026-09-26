/**
 * The external agents a user has set up and the conversations open with them,
 * plus the push channel to the window.
 *
 * Open sessions live as long as the app does. History is the agent's own —
 * `session/list` reads it, `session/load` reopens it — so nothing about a
 * conversation is stored here, and one started in the agent's own CLI shows up
 * next to the ones NekoCode started. Snapshots are coalesced: an agent can
 * stream hundreds of tiny updates a second and the window only needs to see
 * the latest one per frame or so.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import type {
	AcpAgentInfo,
	AcpCreateSessionRequest,
	AcpHistory,
	AcpHistoryEntry,
	AcpOpenSessionRequest,
	AcpPermissionResponse,
	AcpPromptRequest,
	AcpSaveAgentRequest,
	AcpSessionSnapshot,
	AcpSetConfigRequest,
	AcpState,
} from "../../shared/acp";
import { StdioTransport } from "../mcp/transport";
import { acpAgentInfo, agentProxyEnv, type AcpAgentDefinition } from "./agents";
import { authenticateAgent } from "./auth";
import { resolveAgentBinary, type AgentBinary } from "./binaries";
import { agentLaunch, type AgentLaunch } from "./launch";
import type { AcpConfigStore } from "./config-store";
import { AcpConnection, type AcpTransport } from "./connection";
import { ACP_PROTOCOL_VERSION, AcpSession, type AcpToolServers } from "./session";

const PUSH_INTERVAL_MS = 50;
/** A history listing keeps its agent process this long for the next one. */
const LISTER_IDLE_MS = 60_000;
const LISTER_TIMEOUT_MS = 120_000;
/** `session/list` pages; codex-acp serves 25 per page. */
const MAX_HISTORY_PAGES = 8;
/**
 * Idle conversations kept open. Each one is a live agent process, and clicking
 * through history would otherwise leave one behind per row; closing costs
 * nothing, since the agent keeps the history and reopening reloads it.
 */
const MAX_IDLE_SESSIONS = 4;

export interface AcpServiceOptions {
	clientVersion: string;
	store: Pick<AcpConfigStore, "list" | "find" | "save" | "remove">;
	emitState: (state: AcpState) => void;
	emitSnapshot: (snapshot: AcpSessionSnapshot) => void;
	/** An agent's history may have changed: a turn ended, so a title or time moved. */
	emitHistoryChanged?: (agentId: string) => void;
	/** The proxy NekoCode itself uses, handed on to each agent it starts. */
	proxyUrl?: () => string | undefined;
	/** `app.getAppPath()`, where the bundled adapters are found. */
	appRoot?: string;
	/** Locates the user's own agent CLI; injectable for tests. */
	findCli?: (binary: AgentBinary) => string | undefined;
	/** NekoCode's tools for a session, served to the agent over MCP. */
	toolServers?: (session: { sessionId: string; cwd: string }) => Promise<AcpToolServers>;
	createTransport?: (agent: AcpAgentDefinition, cwd: string) => AcpTransport;
}

interface Lister {
	connection: AcpConnection;
	ready: Promise<Record<string, unknown>>;
	timer: ReturnType<typeof setTimeout> | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function requireDirectory(cwd: string): void {
	// Spawning into a missing cwd fails as "spawn cmd.exe ENOENT", which
	// blames the shell for what is really a bad directory.
	if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`项目目录不存在：${cwd}`);
	}
}

/** One page of `session/list`, reduced to what the sidebar shows. */
export function parseHistoryPage(result: unknown): { entries: AcpHistoryEntry[]; nextCursor?: string } {
	const page = isObject(result) ? result : {};
	const entries = (Array.isArray(page.sessions) ? page.sessions : []).filter(isObject).flatMap((entry) => {
		if (typeof entry.sessionId !== "string" || typeof entry.cwd !== "string") return [];
		const updatedAt = typeof entry.updatedAt === "string" ? Date.parse(entry.updatedAt) : Number.NaN;
		return [
			{
				sessionId: entry.sessionId,
				cwd: entry.cwd,
				title: typeof entry.title === "string" ? entry.title.trim() : "",
				updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
			},
		];
	});
	return { entries, ...(typeof page.nextCursor === "string" && page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

export class AcpService {
	private readonly sessions = new Map<string, AcpSession>();
	private readonly dirty = new Set<string>();
	private readonly listers = new Map<string, Lister>();
	/** When each session was last opened, prompted or looked at. */
	private readonly touched = new Map<string, number>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly options: AcpServiceOptions) {}

	agents(): AcpAgentInfo[] {
		const findCli = this.options.findCli ?? ((binary: AgentBinary) => resolveAgentBinary(binary));
		return this.options.store.list().map((agent) => acpAgentInfo(agent, findCli));
	}

	/**
	 * How to start `agent`. Throws `AcpSetupError` when it cannot be: the
	 * adapter is missing, or the CLI it drives is not installed.
	 */
	private launch(agent: AcpAgentDefinition): AgentLaunch {
		return agentLaunch(agent, {
			execPath: process.execPath,
			appRoot: this.options.appRoot ?? process.cwd(),
			platform: process.platform,
			baseEnv: process.env,
			findCli: this.options.findCli ?? ((binary) => resolveAgentBinary(binary)),
		});
	}

	state(): AcpState {
		return {
			agents: this.agents(),
			sessions: [...this.sessions.values()]
				.map((session) => session.summary())
				.sort((a, b) => b.updatedAt - a.updatedAt),
		};
	}

	snapshot(sessionId: string): AcpSessionSnapshot | null {
		return this.sessions.get(sessionId)?.snapshot() ?? null;
	}

	/** The window is showing this session; it is the last to be closed as idle. */
	view(sessionId: string): AcpSessionSnapshot | null {
		if (this.sessions.has(sessionId)) this.touched.set(sessionId, Date.now());
		return this.snapshot(sessionId);
	}

	/** Close the least recently used idle sessions past the limit. */
	private evictIdle(): void {
		const idle = [...this.sessions.values()]
			.filter((session) => {
				const snapshot = session.snapshot();
				return (snapshot.status === "ready" || snapshot.status === "error") && snapshot.permissions.length === 0;
			})
			.sort((a, b) => (this.touched.get(b.id) ?? 0) - (this.touched.get(a.id) ?? 0));
		for (const session of idle.slice(MAX_IDLE_SESSIONS)) this.close(session.id);
	}

	saveAgent(request: AcpSaveAgentRequest): AcpAgentInfo[] {
		const saved = this.options.store.save(request);
		// A changed command or environment has to reach the next listing.
		this.dropLister(saved.id);
		this.options.emitState(this.state());
		return this.agents();
	}

	removeAgent(id: string): AcpAgentInfo[] {
		this.options.store.remove(id);
		this.dropLister(id);
		this.options.emitState(this.state());
		return this.agents();
	}

	private requireAgent(agentId: string): AcpAgentDefinition {
		const agent = this.options.store.find(agentId);
		if (!agent) throw new Error(`未知的代理：${agentId}`);
		if (!agent.enabled) throw new Error(`${agent.name} 已在设置中停用`);
		return agent;
	}

	private transport(agent: AcpAgentDefinition, cwd: string): AcpTransport {
		if (this.options.createTransport) return this.options.createTransport(agent, cwd);
		const launch = this.launch(agent);
		const env = { ...agentProxyEnv(this.options.proxyUrl?.(), process.env), ...launch.env };
		return new StdioTransport({ command: launch.command, args: launch.args, env, cwd, shell: launch.shell });
	}

	private start(
		agent: AcpAgentDefinition,
		cwd: string,
		resume?: { sessionId: string; title?: string },
		processCwd?: string,
	): AcpSession {
		const id = randomUUID();
		const session = new AcpSession({
			id,
			agent,
			cwd,
			clientVersion: this.options.clientVersion,
			createTransport: (target, dir) => this.transport(target, dir),
			onChange: () => this.markDirty(id),
			...(resume ? { resume } : {}),
			...(processCwd ? { processCwd } : {}),
			...(this.options.toolServers
				? { toolServers: () => this.options.toolServers!({ sessionId: id, cwd }) }
				: {}),
		});
		this.sessions.set(id, session);
		this.touched.set(id, Date.now());
		void session.start();
		this.evictIdle();
		this.options.emitState(this.state());
		return session;
	}

	/** Starts the agent in the background; the returned snapshot is still `starting`. */
	create(request: AcpCreateSessionRequest): AcpSessionSnapshot {
		const agent = this.requireAgent(request.agentId);
		if (!request.cwd) throw new Error("请先选择项目目录");
		if (request.warm) {
			for (const session of this.sessions.values()) {
				const summary = session.summary();
				if (summary.agentId === agent.id && summary.cwd === request.cwd && summary.pristine && summary.status !== "error") {
					return this.view(session.id)!;
				}
			}
		}
		requireDirectory(request.cwd);
		// Fail here, where the window shows the reason, not in a dead session.
		if (!this.options.createTransport) this.launch(agent);
		return this.start(agent, request.cwd).snapshot();
	}

	/**
	 * Show a conversation from the agent's history. One already open here is
	 * returned as is — two processes driving the same conversation would each
	 * append to it without seeing the other's turns.
	 */
	openHistory(request: AcpOpenSessionRequest): AcpSessionSnapshot {
		const agent = this.requireAgent(request.agentId);
		for (const session of this.sessions.values()) {
			const summary = session.summary();
			if (summary.agentId === agent.id && summary.agentSessionId === request.sessionId) return this.view(session.id)!;
		}
		if (!this.options.createTransport) this.launch(agent);
		// The history outlives the project: a deleted directory still opens for
		// reading, with the agent started somewhere that exists.
		const exists = statSync(request.cwd, { throwIfNoEntry: false })?.isDirectory() === true;
		return this.start(
			agent,
			request.cwd,
			{ sessionId: request.sessionId, ...(request.title ? { title: request.title } : {}) },
			exists ? undefined : homedir(),
		).snapshot();
	}

	/**
	 * The agent's own list of conversations, newest first. Failures come back
	 * as `error` rather than thrown: the sidebar still shows what is open here.
	 */
	async history(agentId: string): Promise<AcpHistory> {
		let agent: AcpAgentDefinition;
		try {
			agent = this.requireAgent(agentId);
		} catch (error) {
			return { agentId, entries: [], error: errorText(error) };
		}
		try {
			const lister = this.lister(agent);
			const capabilities = await lister.ready;
			const sessionCapabilities = isObject(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
			if (sessionCapabilities.list === undefined) {
				this.scheduleListerIdle(agent.id);
				return { agentId, entries: [], error: `${agent.name} 不提供会话历史` };
			}
			const entries: AcpHistoryEntry[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
				const result = parseHistoryPage(await lister.connection.request("session/list", cursor ? { cursor } : {}));
				entries.push(...result.entries);
				cursor = result.nextCursor;
				if (!cursor) break;
			}
			this.scheduleListerIdle(agent.id);
			return { agentId, entries: entries.sort((a, b) => b.updatedAt - a.updatedAt) };
		} catch (error) {
			this.dropLister(agent.id);
			return { agentId, entries: [], error: errorText(error) };
		}
	}

	/**
	 * A process kept for listing history. Separate from the sessions' own: a
	 * session's process lives exactly as long as that conversation is open, and
	 * the sidebar needs a listing before any is.
	 */
	private lister(agent: AcpAgentDefinition): Lister {
		const existing = this.listers.get(agent.id);
		if (existing && !existing.connection.closed) {
			if (existing.timer) clearTimeout(existing.timer);
			existing.timer = null;
			return existing;
		}
		const connection = new AcpConnection(this.transport(agent, homedir()));
		const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${agent.name} 启动超时`)), LISTER_TIMEOUT_MS);
			connection
				.request("initialize", {
					protocolVersion: ACP_PROTOCOL_VERSION,
					clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
					clientInfo: { name: "nekocode", title: "NekoCode", version: this.options.clientVersion },
				})
				.then(async (init) => {
					// An agent that signs in up front will not list sessions before it has.
					const auth = agent.native?.auth;
					if (auth?.when === "always") {
						await authenticateAgent(
							(method, params) => connection.request(method, params),
							auth,
							init,
							{ ...process.env, ...agent.native?.env, ...agent.env },
							agent.name,
						);
					}
					return init;
				})
				.then(
					(init) => {
						clearTimeout(timer);
						resolve(isObject(init) && isObject(init.agentCapabilities) ? init.agentCapabilities : {});
					},
					(error: unknown) => {
						clearTimeout(timer);
						reject(error instanceof Error ? error : new Error(String(error)));
					},
				);
		});
		const lister: Lister = { connection, ready, timer: null };
		this.listers.set(agent.id, lister);
		connection.onClose(() => {
			if (this.listers.get(agent.id) === lister) this.listers.delete(agent.id);
		});
		return lister;
	}

	private scheduleListerIdle(agentId: string): void {
		const lister = this.listers.get(agentId);
		if (!lister) return;
		if (lister.timer) clearTimeout(lister.timer);
		lister.timer = setTimeout(() => this.dropLister(agentId), LISTER_IDLE_MS);
	}

	private dropLister(agentId: string): void {
		const lister = this.listers.get(agentId);
		if (!lister) return;
		this.listers.delete(agentId);
		if (lister.timer) clearTimeout(lister.timer);
		lister.connection.close("history listing closed");
	}

	private require(sessionId: string): AcpSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("会话不存在或已关闭");
		return session;
	}

	/**
	 * Resolves as soon as the turn has started; its progress arrives as
	 * snapshots. A failure to even start the turn is thrown to the caller.
	 */
	async prompt(request: AcpPromptRequest): Promise<void> {
		const session = this.require(request.sessionId);
		this.touched.set(session.id, Date.now());
		const turn = session.prompt(request.text, request.images ?? []);
		// A turn that ends changes the agent's history — its title, its time.
		turn.then(
			() => this.options.emitHistoryChanged?.(session.agent.id),
			() => undefined,
		);
		// A refused turn rejects before `prompt` reaches its first await, so it is
		// already settled here and wins the race; a running turn loses it.
		await Promise.race([turn, Promise.resolve()]);
	}

	cancel(sessionId: string): Promise<void> {
		return this.require(sessionId).cancel();
	}

	setConfig(request: AcpSetConfigRequest): Promise<void> {
		return this.require(request.sessionId).setConfig(request.configId, request.value);
	}

	respondPermission(response: AcpPermissionResponse): void {
		this.require(response.sessionId).respondPermission(response.requestId, response.optionId);
	}

	close(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.sessions.delete(sessionId);
		this.dirty.delete(sessionId);
		this.touched.delete(sessionId);
		session.dispose();
		this.options.emitState(this.state());
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		for (const session of this.sessions.values()) session.dispose();
		this.sessions.clear();
		this.dirty.clear();
		for (const agentId of [...this.listers.keys()]) this.dropLister(agentId);
	}

	private markDirty(sessionId: string): void {
		this.dirty.add(sessionId);
		this.timer ??= setTimeout(() => this.flush(), PUSH_INTERVAL_MS);
	}

	private flush(): void {
		this.timer = null;
		const ids = [...this.dirty];
		this.dirty.clear();
		for (const id of ids) {
			const snapshot = this.snapshot(id);
			if (snapshot) this.options.emitSnapshot(snapshot);
		}
		if (ids.length > 0) this.options.emitState(this.state());
	}
}
