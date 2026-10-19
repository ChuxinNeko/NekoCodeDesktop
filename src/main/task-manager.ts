import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { AgentService } from "./agent-service";
import { DESKTOP_LIMITS, remoteView } from "./agent-remote-view";
import type {
	AgentSnapshot,
	ExtensionUiAnswer,
	OpenSessionRequest,
	RenameSessionRequest,
	SendPromptResult,
	SessionSummary,
	StartBackgroundTaskResult,
} from "../shared/agent";
import { sortTaskBoard, taskBoardEntry, type TaskBoardEntry, type TaskRunTimes } from "../shared/task-board";

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

/** Where a task has its own checkout; see {@link TaskManager.board}. */
export type WorktreeLookup = (sessionId: string) => { branch: string; base: string } | null;

/** Owns execution lifetimes independently of the desktop's selected transcript. */
export class TaskManager {
	readonly owner: AgentService;
	active: AgentService;
	private agents = new Set<AgentService>();
	private snapshots = new Map<AgentService, AgentSnapshot>();
	/**
	 * Sessions that have run since the app started — what the task board lists.
	 * Opening an old session to read it is not running it, so it stays off the
	 * board until it is prompted.
	 */
	private runs = new Map<AgentService, TaskRunTimes>();
	private opening = new Map<string, Promise<AgentService>>();
	private closed = false;
	private transition: Promise<unknown> = Promise.resolve();
	private listCache: { at: number; rows: SessionSummary[] } | undefined;
	private listRead: Promise<void> | undefined;
	private listRevision = 0;
	/**
	 * Where each transcript window the desktop holds begins, by session: the
	 * first cell it was sent. Pinned rather than recomputed from the tail, so a run adding cells at
	 * the bottom never pulls rows out from under the top of the viewport.
	 */
	private viewFrom = new Map<string, string>();
	/**
	 * Sessions the window shows side by side besides the selected one. Each
	 * keeps streaming into its own pane, so their snapshots are sent on too —
	 * as `agent:paneSnapshot`, which never moves the selection.
	 */
	private watched = new Set<AgentService>();
	/** Only the latest {@link watch} sets the panes; an earlier one still opening must not undo it. */
	private watchSeq = 0;

	constructor(
		private factory: AgentFactory,
		private emit: (channel: string, payload?: unknown) => void,
		private onSettled?: SettledListener,
		private onSnapshot?: SnapshotListener,
		/**
		 * The board changed. Called on every snapshot of a task on it — a stream
		 * of them while anything runs — so the listener is expected to coalesce.
		 */
		private onBoardChanged?: () => void,
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
				// Not on every message: a refresh walks the session directory, and a
				// long run adds messages by the hundred. The row only needs to
				// hear when its session starts having any (its file appears), when it
				// is named, and when a run starts or stops.
				const hadMessages = (previous?.session.messageCount ?? 0) > 0;
				const hasMessages = (next?.session.messageCount ?? 0) > 0;
				if (previous?.session.id !== next?.session.id || previous?.streaming !== next?.streaming ||
					previous?.session.title !== next?.session.title || hadMessages !== hasMessages) {
					this.changed();
				}
				// A run ending is the one transition nobody is necessarily watching:
				// the task may have been started here and left behind two sessions ago.
				if (previous?.streaming && next && !next.streaming) {
					this.onSettled?.(next.session, this.active === agent);
				}
				if (next?.streaming && !previous?.streaming) this.runs.set(agent, { startedAt: Date.now(), endedAt: null });
				const run = this.runs.get(agent);
				if (run && previous?.streaming && next && !next.streaming) run.endedAt = Date.now();
				if (run) this.onBoardChanged?.();
				if (next) this.onSnapshot?.(next);
			}
			if (channel === "agent:sessionsChanged") this.changed();
			else if (this.active === agent)
				this.emit(channel, channel === "agent:snapshot" ? this.view(payload as AgentSnapshot | null) : payload);
			else if (channel === "agent:snapshot" && payload && this.watched.has(agent))
				this.emit("agent:paneSnapshot", this.view(payload as AgentSnapshot));
		}, this.owner);
		this.agents.add(agent);
		return agent;
	}

	private changed(): void {
		this.listRevision++;
		this.listCache = undefined;
		this.emit("agent:sessionsChanged");
	}

	private select(agent: AgentService): AgentSnapshot {
		const snapshot = agent.getSnapshot();
		if (!snapshot) throw new Error("Session is unavailable");
		const previous = this.active;
		this.active = agent;
		this.snapshots.set(agent, snapshot);
		// A session is always opened at its end; how far back it was read last
		// time belongs to that visit. A pane on screen is still that visit.
		if (!this.watched.has(agent)) this.viewFrom.delete(snapshot.session.id);
		// The pane that just lost focus only heard `agent:snapshot` while it had
		// it; bring its own copy up to date before the new selection arrives.
		if (previous !== agent && this.watched.has(previous)) {
			const left = previous.getSnapshot();
			if (left) this.emit("agent:paneSnapshot", this.view(left));
		}
		this.emit("agent:snapshot", this.view(snapshot));
		return snapshot;
	}

	/**
	 * What the desktop window is sent of the selected session's snapshot.
	 *
	 * A long session is a transcript of thousands of cells, and mounting them
	 * all is what made opening one stall. The window gets the tail, grows
	 * backwards only through {@link loadEarlier}, and carries oversized tool
	 * payloads as a head it can fetch the rest of. Every snapshot bound for the
	 * window goes through here — pushed ones and replies alike — or one full
	 * transcript slipping through would put the whole session back on screen.
	 */
	view(snapshot: AgentSnapshot | null, back = 0): AgentSnapshot | null {
		if (!snapshot) return null;
		const sessionId = snapshot.session.id;
		const view = remoteView(snapshot, { from: this.viewFrom.get(sessionId), back }, DESKTOP_LIMITS);
		const first = view.snapshot.cells[0];
		if (first) this.viewFrom.set(sessionId, first.id);
		else this.viewFrom.delete(sessionId);
		return view.earlier > 0 ? { ...view.snapshot, earlierCells: view.earlier } : view.snapshot;
	}

	/**
	 * The selected session's window as last reported, falling back to building
	 * one. A reply to an open or a create reads this rather than building its
	 * own: `select` has just built the snapshot.
	 */
	viewOf(agent: AgentService): AgentSnapshot | null {
		return this.view(this.snapshots.get(agent) ?? agent.getSnapshot());
	}

	/** Reach one page further back into the selected session. */
	loadEarlier(): AgentSnapshot | null {
		return this.view(this.active.getSnapshot(), DESKTOP_LIMITS.step);
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

	/**
	 * Set the sessions shown in the window's panes, opening any not yet live.
	 * Replaces the previous set; an empty list ends the split view. Answers with
	 * each pane's window — a session that could not be opened is left out
	 * rather than failing the rest.
	 */
	async watch(requests: readonly OpenSessionRequest[]): Promise<AgentSnapshot[]> {
		const seq = ++this.watchSeq;
		const agents = await Promise.all(requests.map((req) => this.open(req, false).catch(() => null)));
		if (seq !== this.watchSeq) return [];
		const next = new Set(agents.filter((agent): agent is AgentService => agent !== null && this.agents.has(agent)));
		for (const agent of this.watched) {
			const id = this.snapshots.get(agent)?.session.id;
			if (!next.has(agent) && agent !== this.active && id) this.viewFrom.delete(id);
		}
		this.watched = next;
		return [...next].flatMap((agent) => {
			const snapshot = this.viewOf(agent);
			return snapshot ? [snapshot] : [];
		});
	}

	/**
	 * Every task on the board, the ones needing attention first.
	 *
	 * Built on request from the snapshots already held, so a board nobody is
	 * looking at costs nothing.
	 */
	board(worktreeOf?: WorktreeLookup): TaskBoardEntry[] {
		const entries: TaskBoardEntry[] = [];
		for (const [agent, run] of this.runs) {
			const snapshot = this.snapshots.get(agent);
			if (!snapshot) continue;
			entries.push(taskBoardEntry(snapshot, {
				run,
				worktree: worktreeOf?.(snapshot.session.id) ?? null,
				selected: agent === this.active,
			}));
		}
		return sortTaskBoard(entries);
	}

	/** Take finished tasks off the board. The sessions themselves stay, in the sidebar. */
	dismiss(sessionIds: readonly string[]): void {
		const ids = new Set(sessionIds);
		let changed = false;
		for (const agent of [...this.runs.keys()]) {
			const snapshot = this.snapshots.get(agent);
			if (!snapshot || !ids.has(snapshot.session.id) || snapshot.streaming || snapshot.workflow.request) continue;
			this.runs.delete(agent);
			changed = true;
		}
		if (changed) this.onBoardChanged?.();
	}

	/** Address a shell call without switching the selected session. */
	stopCommand(sessionId: string, toolCallId: string): boolean {
		const agent = [...this.snapshots].find(([, snapshot]) => snapshot.session.id === sessionId)?.[0];
		return agent?.stopCommand(toolCallId) ?? false;
	}

	/** Stop one live task, whichever session is on screen. */
	async abortSession(sessionId: string): Promise<void> {
		const agent = [...this.snapshots].find(([, snapshot]) => snapshot.session.id === sessionId)?.[0];
		await agent?.abort();
	}

	async list(cwd?: string): Promise<SessionSummary[]> {
		if (!this.listCache || Date.now() - this.listCache.at > 5000) {
			if (!this.listRead) {
				const revision = this.listRevision;
				this.listRead = this.owner.listSessions().then(rows => {
					// A rename/delete during scanning must not resurrect stale rows.
					if (revision === this.listRevision) this.listCache = { at: Date.now(), rows };
				}).finally(() => { this.listRead = undefined; });
			}
			await this.listRead;
			if (!this.listCache) return this.list(cwd);
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

	/** Connected tools belong to every live session, not only the selected one. */
	syncMcpTools(): void {
		for (const agent of this.agents) agent.syncMcpTools();
	}

	/** Every open session rebuilds its system prompt from the prompts now in settings. */
	refreshPrompts(): void {
		for (const agent of this.agents) agent.refreshPrompt();
	}

	/** Every open session re-reads its project instructions; see {@link AgentService.reloadContext}. */
	async reloadContext(): Promise<void> {
		// One at a time: a reload resets the core's provider registry, which is
		// process-wide, and two interleaved resets could each undo the other.
		for (const agent of [...this.agents]) await agent.reloadContext();
	}

	/**
	 * A plugin was installed, removed, updated or toggled through `changed`:
	 * every other open session reloads its extensions too. In the background and
	 * one at a time — a reload resets the core's process-wide provider registry,
	 * and one still running a turn waits for it to end (see `reloadContext`).
	 */
	reloadPlugins(changed: AgentService): void {
		const others = [...this.agents].filter((agent) => agent !== changed);
		void (async () => {
			for (const agent of others) {
				if (this.closed || !this.agents.has(agent)) continue;
				await agent.reloadContext().catch(() => undefined);
			}
		})();
	}

	/** Route a plugin dialog's answer to the session that asked, on screen or not. */
	async answerExtensionUi(sessionId: string, answer: ExtensionUiAnswer): Promise<AgentSnapshot | null> {
		const agent = [...this.snapshots].find(([, snapshot]) => snapshot.session.id === sessionId)?.[0];
		if (!agent) return null;
		return this.view(agent.answerExtensionUi(answer));
	}

	private drop(agent: AgentService): void {
		const id = this.snapshots.get(agent)?.session.id;
		if (id) this.viewFrom.delete(id);
		this.agents.delete(agent);
		this.snapshots.delete(agent);
		this.watched.delete(agent);
		if (this.runs.delete(agent)) this.onBoardChanged?.();
		agent.close();
	}

	private prune(): void {
		if (this.agents.size < 32) return;
		// Sessions only opened to be read go before finished ones still on the
		// task board, which someone may yet come back to.
		const candidates = [...this.agents].sort((a, b) => Number(this.runs.has(a)) - Number(this.runs.has(b)));
		for (const agent of candidates) {
			const snapshot = this.snapshots.get(agent);
			if (agent !== this.active && agent !== this.owner && !this.watched.has(agent) && snapshot && !snapshot.streaming && !snapshot.workflow.request && existsSync(snapshot.session.sessionFile)) {
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
		this.runs.clear();
		this.watched.clear();
		this.viewFrom.clear();
	}
}
