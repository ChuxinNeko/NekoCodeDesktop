import { acpProviderEnv, acpProviderSessionMeta } from "./providers";
import { acpModelEnv } from "./model-settings";
import { nativeConfigEnvironment } from "./native-config";
/**
 * The external agents a user has set up and the conversations open with them,
 * plus the push channel to the window.
 *
 * Open sessions live as long as the app does. History is the agent's own —
 * `session/list` reads it, `session/load` reopens it, `session/delete` optionally
 * removes it. Prompt usage and sidebar removals are stored locally; one started in the agent's own CLI shows up
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
	AcpDeleteSessionRequest,
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
import { StdioTransport } from "./stdio-transport";
import { acpAgentInfo, agentProxyEnv, type AcpAgentDefinition } from "./agents";
import { authenticateAgent } from "./auth";
import { resolveAgentBinary, type AgentBinary } from "./binaries";
import { agentLaunch, type AgentLaunch } from "./launch";
import type { AcpConfigStore } from "./config-store";
import { AcpConnection, type AcpTransport } from "./connection";
import { ACP_PROTOCOL_VERSION, AcpSession, type AcpToolServers } from "./session";
import type { TextDiffer } from "./projection";
import { openShellChanges, type ShellChangeTracker } from "./workspace-changes";
import { AcpUsageStore } from "./usage-store";
import { AcpDeletedSessions } from "./deleted-sessions";
import { AcpSessionDefaults } from "./session-defaults";

const PUSH_INTERVAL_MS = 50;
/** A history listing keeps its agent process this long for the next one. */
const LISTER_IDLE_MS = 60_000;
const LISTER_TIMEOUT_MS = 120_000;
/** `session/list` pages; codex-acp serves 25 per page. */
const MAX_HISTORY_PAGES = 8;
/**
 * Idle conversations kept open when no tasks are running; active tasks consume
 * this cache budget, leaving at least one slot for the next conversation.
 * Each one is a live agent process, and clicking
 * through history would otherwise leave one behind per row; closing costs
 * nothing, since the agent keeps the history and reopening reloads it.
 */
const MAX_IDLE_SESSIONS = 4;

export interface AcpServiceOptions {
	/** Injectable deadline for history requests; stalled agents must not retain processes forever. */
	historyTimeoutMs?: number;
	/** Application data directory for durable sidebar removals. */
	userDataDir?: string;
	nativeConfig?: boolean;
	autoRetryCount?: () => number;
	/** Durable prompt usage, read by the settings token dashboard. */
	usageDir?: string;
	clientVersion: string;
	store: Pick<AcpConfigStore, "list" | "find" | "save" | "remove"> & Partial<Pick<AcpConfigStore, "syncNative">>;
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
	/** Line diffs for the edit cards; pi's, loaded on demand. */
	textDiffer?: () => Promise<TextDiffer>;
	/** Watches what shell commands change in a project; git-backed unless a test says otherwise. */
	shellChanges?: (cwd: string) => Promise<ShellChangeTracker | null>;
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

const TRANSCRIPT_WINDOW_CELLS = 80;

export class AcpService {
	private readonly sessionDefaults: AcpSessionDefaults;
	private readonly deleted: AcpDeletedSessions;
	private readonly historyFrom = new Map<string, number>();
	private readonly usageStore?: AcpUsageStore;
	private readonly sessions = new Map<string, AcpSession>();
	/** Unsent sessions belong to the client that opened their composer. */
	private readonly warmOwners = new Map<string, string>();
	private readonly dirty = new Set<string>();
	private readonly listers = new Map<string, Lister>();
	private readonly historyRequests = new Map<string, Promise<AcpHistory>>();
	/** When each session was last opened, prompted or looked at. */
	private readonly touched = new Map<string, number>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private touchSequence = 0;
	private disposed = false;

	constructor(private readonly options: AcpServiceOptions) {
		this.sessionDefaults = new AcpSessionDefaults(options.userDataDir);
		this.deleted = new AcpDeletedSessions(options.userDataDir);
		if (options.usageDir) this.usageStore = new AcpUsageStore(options.usageDir);
	}

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
			nativeConfig: this.options.nativeConfig,
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
		if (this.sessions.has(sessionId)) this.touched.set(sessionId, ++this.touchSequence);
		return this.snapshot(sessionId);
	}

	/** Desktop IPC uses a paged window; mobile callers retain their existing full view. */
	desktopView(sessionId: string, loadEarlier = false): AcpSessionSnapshot | null {
		if (!this.sessions.has(sessionId)) return null;
		this.touched.set(sessionId, ++this.touchSequence);
		if (loadEarlier) {
			const total = this.snapshot(sessionId)?.cells.length ?? 0;
			this.historyFrom.set(sessionId, Math.max(0, (this.historyFrom.get(sessionId) ?? Math.max(0, total - TRANSCRIPT_WINDOW_CELLS)) - TRANSCRIPT_WINDOW_CELLS));
		} else this.historyFrom.delete(sessionId);
		const snapshot = this.windowSnapshot(sessionId);
		if (loadEarlier && snapshot) this.options.emitSnapshot(snapshot);
		return snapshot;
	}

	/** Background streams and initial reads stay bounded until history is requested. */
	private windowSnapshot(sessionId: string): AcpSessionSnapshot | null {
		const snapshot = this.snapshot(sessionId);
		if (!snapshot) return null;
		const offset = Math.min(this.historyFrom.get(sessionId) ?? Math.max(0, snapshot.cells.length - TRANSCRIPT_WINDOW_CELLS), snapshot.cells.length);
		return { ...snapshot, cells: snapshot.cells.slice(offset), ...(offset ? { earlierCells: offset } : {}) };
	}

	/** Close the least recently used idle sessions past the limit. */
	private evictIdle(): void {
		if (this.disposed) return;
		const sessions = [...this.sessions.values()];
		const running = sessions.filter((session) => session.summary().status === "prompting").length;
		// Active conversations already hold their own adapters/CLI/MCP trees.
		// Keep room for one unsent/viewed conversation while four jobs run,
		// rather than retaining another four complete idle process trees.
		const idleLimit = Math.max(1, MAX_IDLE_SESSIONS - running);
		const idle = sessions
			.filter((session) => session.canEvict)
			.sort((a, b) => (this.touched.get(b.id) ?? 0) - (this.touched.get(a.id) ?? 0));
		for (const session of idle.slice(idleLimit)) this.close(session.id);
	}

	saveAgent(request: AcpSaveAgentRequest): AcpAgentInfo[] {
		const previous = request.id ? this.options.store.find(request.id) : undefined;
		const saved = this.options.store.save(request);
		const routing = (agent: AcpAgentDefinition) => this.options.nativeConfig ? JSON.stringify({
			env: agent.env,
			profile: agent.providerState?.profiles.find((profile) => profile.id === agent.providerState?.activeId),
			modelSettings: agent.modelSettings,
		}) : JSON.stringify({
			env: {
				...agent.env,
				...(agent.providerState ? acpProviderEnv(agent.id, agent.providerState) : acpModelEnv(agent.id, agent.modelSettings)),
			},
			meta: acpProviderSessionMeta(agent.id, agent.providerState, agent.bundled?.sessionMeta),
		});
		// An unsent composer must reconnect with the newly selected provider.
		if (previous && (!saved.enabled || routing(previous) !== routing(saved))) {
			for (const session of this.sessions.values()) {
				const summary = session.summary();
				if (summary.agentId === saved.id && summary.pristine && summary.status !== "prompting") this.close(session.id);
			}
		}
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
		if (this.disposed) throw new Error("外部代理服务已关闭");
		const agent = this.options.store.find(agentId);
		if (!agent) throw new Error(`未知的代理：${agentId}`);
		if (!agent.enabled) throw new Error(`${agent.name} 已在设置中停用`);
		if (this.options.nativeConfig) this.options.store.syncNative?.(agentId);
		if (this.options.nativeConfig && (agentId === "claude" || agentId === "codex")) return { ...agent, env: nativeConfigEnvironment(agent) };
		return { ...agent, ...(agent.bundled ? { bundled: { ...agent.bundled, sessionMeta: acpProviderSessionMeta(agent.id, agent.providerState, agent.bundled.sessionMeta) } } : {}), env: {
			...agent.env,
			...(agent.providerState ? acpProviderEnv(agent.id, agent.providerState) : acpModelEnv(agent.id, agent.modelSettings)),
		} };
	}

	private transport(agent: AcpAgentDefinition, cwd: string): AcpTransport {
		if (this.options.createTransport) return this.options.createTransport(agent, cwd);
		const launch = this.launch(agent);
		const env = { ...agentProxyEnv(this.options.proxyUrl?.(), process.env), ...launch.env };
		return new StdioTransport({ command: launch.command, args: launch.args, env, unsetEnv: launch.unsetEnv, cwd, shell: launch.shell });
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
			initialConfig: this.sessionDefaults.get(agent.id),
			onConfigApplied: (configId, value) => this.sessionDefaults.set(agent.id, configId, value),
			autoRetryCount: this.options.autoRetryCount,
			createTransport: (target, dir) => this.transport(target, dir),
			onChange: () => this.markDirty(id),
			onUsage: (usage, timestamp) => this.usageStore?.record(session.summary(), usage, timestamp),
			...(resume ? { resume } : {}),
			...(processCwd ? { processCwd } : {}),
			...(this.options.toolServers
				? { toolServers: () => this.options.toolServers!({ sessionId: id, cwd }) }
				: {}),
			...(this.options.textDiffer ? { textDiffer: this.options.textDiffer } : {}),
			// A history entry whose project is gone has no tree to watch.
			...(processCwd ? {} : { shellChanges: () => (this.options.shellChanges ?? openShellChanges)(cwd) }),
		});
		this.sessions.set(id, session);
		this.touched.set(id, ++this.touchSequence);
		void session.start().then(() => this.evictIdle());
		this.evictIdle();
		this.options.emitState(this.state());
		return session;
	}

	/** Starts the agent in the background; the returned snapshot is still `starting`. */
	create(request: AcpCreateSessionRequest, owner?: string): AcpSessionSnapshot {
		const agent = this.requireAgent(request.agentId);
		if (!request.cwd) throw new Error("请先选择项目目录");
		// No client identity means no safe basis for reusing a new conversation.
		if (request.warm && owner) {
			for (const session of this.sessions.values()) {
				if (this.warmOwners.get(session.id) !== owner) continue;
				const summary = session.summary();
				if (summary.agentId === agent.id && summary.cwd === request.cwd && summary.pristine && summary.status !== "error") {
					return this.view(session.id)!;
				}
			}
		}
		requireDirectory(request.cwd);
		// Fail here, where the window shows the reason, not in a dead session.
		if (!this.options.createTransport) this.launch(agent);
		if (request.warm && owner) {
			// A window has one unsent composer. Replacing it must release its old
			// process tree, including a startup that has not completed yet.
			for (const [id, session] of this.sessions) {
				if (this.warmOwners.get(id) === owner && session.summary().pristine) this.close(id);
			}
		}
		const session = this.start(agent, request.cwd);
		if (request.warm && owner) this.warmOwners.set(session.id, owner);
		return session.snapshot();
	}

	/**
	 * Show a conversation from the agent's history. One already open here is
	 * returned as is — two processes driving the same conversation would each
	 * append to it without seeing the other's turns.
	 */
	openHistory(request: AcpOpenSessionRequest): AcpSessionSnapshot {
		if (this.deleted.has(request.agentId, request.sessionId)) throw new Error("此会话已从 NekoCode 删除");
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
	history(agentId: string): Promise<AcpHistory> {
		const existing = this.historyRequests.get(agentId);
		if (existing) return existing;
		const request = this.loadHistory(agentId);
		this.historyRequests.set(agentId, request);
		const forget = () => {
			if (this.historyRequests.get(agentId) === request) this.historyRequests.delete(agentId);
		};
		void request.then(forget, forget);
		return request;
	}

	private async loadHistory(agentId: string): Promise<AcpHistory> {
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
				const result = parseHistoryPage(await this.historyPage(lister, agent.name, cursor));
				entries.push(...result.entries);
				cursor = result.nextCursor;
				if (!cursor) break;
			}
			this.scheduleListerIdle(agent.id);
			return { agentId, entries: entries.filter((entry) => !this.deleted.has(agentId, entry.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt) };
		} catch (error) {
			this.dropLister(agent.id);
			return { agentId, entries: [], error: errorText(error) };
		}
	}

	private historyPage(lister: Lister, name: string, cursor?: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${name} 读取会话历史超时`)), this.options.historyTimeoutMs ?? LISTER_TIMEOUT_MS);
			lister.connection.request("session/list", cursor ? { cursor } : {}).then(
				(result) => { clearTimeout(timer); resolve(result); },
				(error: unknown) => { clearTimeout(timer); reject(error); },
			);
		});
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
			if (lister.timer) clearTimeout(lister.timer);
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
		this.touched.set(session.id, ++this.touchSequence);
		if (request.steer) return session.steer(request.text, request.images ?? []);
		const turn = session.prompt(request.text, request.images ?? []);
		// A turn that ends changes the agent's history — its title, its time.
		turn.then(
			() => { this.evictIdle(); if (!this.disposed) this.options.emitHistoryChanged?.(session.agent.id); },
			() => this.evictIdle(),
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

	async deleteSession(request: AcpDeleteSessionRequest): Promise<void> {
		if (!request || typeof request.agentId !== "string" || !request.agentId) throw new Error("无效的代理 ID");
		let agentSessionId = request.sessionId;
		if (request.localSessionId !== undefined) {
			const session = this.require(request.localSessionId).summary();
			if (session.agentId !== request.agentId) throw new Error("会话不属于此代理");
			agentSessionId = session.agentSessionId;
		} else if (typeof agentSessionId !== "string" || !agentSessionId) {
			throw new Error("无效的会话 ID");
		}
		if (request.deleteFromCli === true) {
			const live = [...this.sessions.values()].find((session) => {
				const summary = session.summary();
				return summary.agentId === request.agentId && summary.status !== "error" &&
					(summary.id === request.localSessionId || (agentSessionId && summary.agentSessionId === agentSessionId));
			});
			if (live) {
				await live.deleteHistory();
				agentSessionId = live.summary().agentSessionId;
			} else {
				if (!agentSessionId) throw new Error("代理尚未分配会话 ID，请稍后重试");
				const agent = this.requireAgent(request.agentId);
				const lister = this.lister(agent);
				try {
					const capabilities = await lister.ready;
					const sessions = isObject(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
					if (!isObject(sessions.delete)) throw new Error(`${agent.name} 不支持删除 CLI 会话，可取消勾选后仅从 NekoCode 移除`);
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => {
							this.dropLister(agent.id);
							reject(new Error(`${agent.name} 删除 CLI 会话超时，请刷新历史后重试`));
						}, LISTER_TIMEOUT_MS);
						lister.connection.request("session/delete", { sessionId: agentSessionId }).then(
							() => { clearTimeout(timer); resolve(); },
							(error: unknown) => { clearTimeout(timer); reject(error); },
						);
					});
				} finally {
					this.scheduleListerIdle(agent.id);
				}
			}
		}
		// Native deletion must succeed before hiding the row locally.
		if (agentSessionId && !request.deleteFromCli) this.deleted.add(request.agentId, agentSessionId);
		for (const session of this.sessions.values()) {
			const summary = session.summary();
			if (summary.agentId === request.agentId && (summary.id === request.localSessionId ||
				(agentSessionId && summary.agentSessionId === agentSessionId))) this.close(summary.id);
		}
		this.options.emitHistoryChanged?.(request.agentId);
		// Native history is already gone: release its live session even if the
		// local bookkeeping write fails, and report that partial result accurately.
		if (agentSessionId && request.deleteFromCli) {
			try { this.deleted.add(request.agentId, agentSessionId); }
			catch (error) { throw new Error(`CLI 会话已删除，但保存本地移除记录失败：${errorText(error)}`); }
		}
	}

	close(sessionId: string): void {
		this.historyFrom.delete(sessionId);
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.sessions.delete(sessionId);
		this.warmOwners.delete(sessionId);
		this.dirty.delete(sessionId);
		this.touched.delete(sessionId);
		session.dispose();
		this.options.emitState(this.state());
	}

	dispose(): void {
		this.disposed = true;
		this.historyFrom.clear();
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		for (const session of this.sessions.values()) session.dispose();
		this.sessions.clear();
		this.warmOwners.clear();
		this.touched.clear();
		this.historyRequests.clear();
		this.dirty.clear();
		for (const agentId of [...this.listers.keys()]) this.dropLister(agentId);
	}

	private markDirty(sessionId: string): void {
		if (this.disposed || !this.sessions.has(sessionId)) return;
		this.dirty.add(sessionId);
		this.timer ??= setTimeout(() => this.flush(), PUSH_INTERVAL_MS);
	}

	private flush(): void {
		this.timer = null;
		this.evictIdle();
		const ids = [...this.dirty];
		this.dirty.clear();
		for (const id of ids) {
			const snapshot = this.windowSnapshot(id);
			if (snapshot) this.options.emitSnapshot(snapshot);
		}
		if (ids.length > 0) this.options.emitState(this.state());
	}
}
