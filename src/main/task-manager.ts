import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { AgentService } from "./agent-service";
import type {
	AgentSnapshot,
	OpenSessionRequest,
	RenameSessionRequest,
	SendPromptResult,
	SessionSummary,
	StartBackgroundTaskResult,
} from "../shared/agent";

export type AgentFactory = (emit: (channel: string, payload?: unknown) => void, owner?: AgentService) => AgentService;

/** A task has stopped running. `selected` is whether it is the one on screen. */
export type SettledListener = (session: SessionSummary, selected: boolean) => void;

/**
 * A task produced a new snapshot, selected or not.
 *
 * Distinct from {@link SettledListener} because a remote front end needs the
 * middle of a run, not only its end: progress to stream, and a workflow question
 * to put to whoever is waiting on it.
 */
export type SnapshotListener = (snapshot: AgentSnapshot) => void;

/** Owns execution lifetimes independently of the desktop's selected transcript. */
export class TaskManager {
	readonly owner: AgentService;
	active: AgentService;
	private agents = new Set<AgentService>();
	private snapshots = new Map<AgentService, AgentSnapshot>();
	private opening = new Map<string, Promise<AgentService>>();
	private closed = false;
	private transition: Promise<unknown> = Promise.resolve();
	private listCache: { at: number; rows: SessionSummary[] } | undefined;

	constructor(
		private factory: AgentFactory,
		private emit: (channel: string, payload?: unknown) => void,
		private onSettled?: SettledListener,
		private onSnapshot?: SnapshotListener,
	) {
		this.owner = this.make();
		this.active = this.owner;
	}

	private make(): AgentService {
		if (this.closed) throw new Error("Task manager is closed");
		let agent: AgentService;
		agent = this.factory((channel, payload) => {
			if (this.closed || !this.agents.has(agent)) return;
			if (channel === "agent:snapshot") {
				const previous = this.snapshots.get(agent);
				const next = payload as AgentSnapshot | null;
				if (next) this.snapshots.set(agent, next);
				else this.snapshots.delete(agent);
				if (previous?.session.id !== next?.session.id || previous?.streaming !== next?.streaming ||
					previous?.session.title !== next?.session.title || previous?.session.messageCount !== next?.session.messageCount) {
					this.changed();
				}
				// A run ending is the one transition nobody is necessarily watching:
				// the task may have been started here and left behind two sessions ago.
				if (previous?.streaming && next && !next.streaming) {
					this.onSettled?.(next.session, this.active === agent);
				}
				if (next) this.onSnapshot?.(next);
			}
			if (channel === "agent:sessionsChanged") this.changed();
			else if (this.active === agent) this.emit(channel, payload);
		}, this.owner);
		this.agents.add(agent);
		return agent;
	}

	private changed(): void {
		this.listCache = undefined;
		this.emit("agent:sessionsChanged");
	}

	private select(agent: AgentService): AgentSnapshot {
		const snapshot = agent.getSnapshot();
		if (!snapshot) throw new Error("Session is unavailable");
		this.active = agent;
		this.emit("agent:snapshot", snapshot);
		return snapshot;
	}

	/** Serialize view changes; task execution itself never holds this queue. */
	private inOrder<T>(action: () => Promise<T>): Promise<T> {
		const result = this.transition.then(action);
		this.transition = result.catch(() => undefined);
		return result;
	}

	async create(cwd: string, select = true): Promise<AgentService> {
		const create = async () => {
			this.prune();
			const agent = this.make();
			agent.inheritDefaults(this.active);
			try {
				await agent.createSession(cwd);
				if (this.closed) throw new Error("Task manager is closed");
				if (select) this.select(agent);
				return agent;
			} catch (error) {
				this.drop(agent);
				throw error;
			}
		};
		return select ? this.inOrder(create) : create();
	}

	/**
	 * Run a prompt in a session of its own, leaving the selection alone.
	 *
	 * Creating and prompting are one step because a session that was created but
	 * never prompted is not a task: if the prompt is refused the session goes
	 * away again rather than settling in the sidebar as a row nobody started.
	 */
	async startBackground(
		cwd: string,
		text: string,
		/**
		 * Applied after the session exists and before the prompt runs.
		 *
		 * A remote caller picks the model for the task it is starting, and a
		 * configure step afterwards would be too late — the turn would already
		 * have gone out on whatever the desktop happened to be set to.
		 */
		configure?: (agent: AgentService) => Promise<void>,
	): Promise<StartBackgroundTaskResult> {
		const agent = await this.create(cwd, false);
		const created = agent.getSnapshot()?.session;
		let result: SendPromptResult;
		try {
			await configure?.(agent);
			result = await agent.send({ text });
		}
		catch (error) { result = { accepted: false, error: error instanceof Error ? error.message : String(error) }; }
		if (result.accepted) {
			// Re-read: the prompt is what gives the row its title and running dot.
			const session = agent.getSnapshot()?.session ?? created;
			return session ? { accepted: true, session } : { accepted: false, error: "Session is unavailable" };
		}
		if (created) await this.remove(created.sessionFile).catch(() => undefined);
		return { accepted: false, error: result.error };
	}

	private find(file: string): AgentService | undefined {
		return [...this.snapshots].find(([, s]) => resolve(s.session.sessionFile) === resolve(file))?.[0];
	}

	async open(req: OpenSessionRequest, select = true): Promise<AgentService> {
		const open = async () => {
			let agent = this.find(req.sessionFile);
			if (!agent) {
				const key = resolve(req.sessionFile);
				let pending = this.opening.get(key);
				if (!pending) {
					pending = (async () => {
						this.prune();
						const next = this.make();
						try {
							await next.openSession(req);
							if (this.closed) throw new Error("Task manager is closed");
							return next;
						} catch (error) { this.drop(next); throw error; }
					})();
					this.opening.set(key, pending);
				}
				try { agent = await pending; }
				finally { this.opening.delete(key); }
			}
			if (select) this.select(agent);
			return agent;
		};
		return select ? this.inOrder(open) : open();
	}

	async list(cwd?: string): Promise<SessionSummary[]> {
		if (!this.listCache || Date.now() - this.listCache.at > 5000) {
			const at = Date.now();
			const rows = await this.owner.listSessions();
			this.listCache = { at, rows };
		}
		const rows = new Map(this.listCache.rows.map((s) => [s.id, s]));
		for (const snapshot of this.snapshots.values()) rows.set(snapshot.session.id, snapshot.session);
		return [...rows.values()].filter((s) => !cwd || resolve(s.cwd) === resolve(cwd))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async byId(id: string): Promise<AgentService> {
		const row = (await this.list()).find((s) => s.id === id);
		if (!row) throw new Error("Task not found");
		return this.open({ cwd: row.cwd, sessionFile: row.sessionFile }, false);
	}

	async defaults(cwd: string) {
		this.owner.inheritDefaults(this.active);
		return this.owner.getDefaults(cwd);
	}

	async rename(req: RenameSessionRequest): Promise<void> {
		await (this.find(req.sessionFile) ?? this.owner).renameSession(req);
		this.changed();
	}

	async remove(sessionFile: string): Promise<void> {
		await this.inOrder(async () => {
			await this.opening.get(resolve(sessionFile));
			const agent = this.find(sessionFile);
			if (agent) {
				await agent.abort();
				await agent.deleteSession({ sessionFile });
				if (agent === this.active) this.active = this.owner;
				if (agent !== this.owner) this.drop(agent);
			} else await this.owner.deleteSession({ sessionFile });
			this.changed();
		});
	}

	async reloadModels(): Promise<void> {
		await this.owner.reloadConfiguredModels();
		await Promise.all([...this.agents].filter((s) => s !== this.owner).map((s) => s.reloadConfiguredModels(false)));
	}

	private drop(agent: AgentService): void {
		this.agents.delete(agent);
		this.snapshots.delete(agent);
		agent.close();
	}

	private prune(): void {
		if (this.agents.size < 32) return;
		for (const agent of this.agents) {
			const snapshot = this.snapshots.get(agent);
			if (agent !== this.active && agent !== this.owner && snapshot && !snapshot.streaming && !snapshot.workflow.request && existsSync(snapshot.session.sessionFile)) {
				this.drop(agent);
				if (this.agents.size < 32) return;
			}
		}
		throw new Error("同时打开的任务过多，请先停止部分任务");
	}

	close(): void {
		this.closed = true;
		for (const agent of this.agents) agent.close();
		this.agents.clear();
		this.snapshots.clear();
	}
}
