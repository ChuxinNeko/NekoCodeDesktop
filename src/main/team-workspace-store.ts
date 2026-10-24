import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { TeamMemory, TeamPost, TeamRoom, TeamWork, TeamWorkspaceAction, TeamWorkspaceSnapshot, TeamSendRequest } from "../shared/team-workspace";
import type { SendPromptResult } from "../shared/agent";
import { currentTeamSettings } from "./team-settings";

interface Data { rooms: TeamRoom[]; posts: TeamPost[]; memory: TeamMemory[]; work: TeamWork[] }
const empty = (): Data => ({ rooms: [], posts: [], memory: [], work: [] });

/** Team identities live in app preferences; conversations and memories have their own durable store. */
export class TeamWorkspaceStore {
	private data: Data = empty();
	private readonly listeners = new Set<() => void>();
	private readonly cancellers = new Map<string, { memberId: string; roomId: string; stop: () => void }>();
	private dispatchMessage?: (request: TeamSendRequest) => Promise<SendPromptResult>;
	constructor(private readonly directory?: string) {
		if (!directory) return;
		try {
			const raw = JSON.parse(readFileSync(join(directory, "team-workspace.json"), "utf8"));
			if (!raw || typeof raw !== "object") return;
			for (const key of ["rooms", "posts", "memory", "work"] as const) if (Array.isArray(raw[key])) this.data[key] = raw[key].filter((entry: unknown) => !!entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string");
			this.data.rooms = this.data.rooms.filter(room => typeof room.name === "string" && Array.isArray(room.members) && room.members.every(id => typeof id === "string") && typeof room.adminId === "string" && typeof room.cwd === "string" && typeof room.notice === "string" && ["admin", "everyone"].includes(room.mode));
			this.data.posts = this.data.posts.filter(post => typeof post.text === "string" && typeof post.roomId === "string" && typeof post.memberId === "string");
			this.data.memory = this.data.memory.filter(entry => typeof entry.scope === "string" && typeof entry.topic === "string" && typeof entry.text === "string");
			this.data.work = this.data.work.filter(work => typeof work.roomId === "string" && typeof work.memberId === "string" && typeof work.task === "string");
			this.data.work = this.data.work.map(work => work.status === "working" ? { ...work, status: "stopped", text: "Application stopped before this task finished." } : work);
			this.data.posts = this.data.posts.map(post => post.status === "streaming" ? { ...post, status: "failed" } : post);
		} catch (error) {
			if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	changed(): void { for (const listener of this.listeners) listener(); }
	setDispatcher(dispatch: (request: TeamSendRequest) => Promise<SendPromptResult>): void { this.dispatchMessage = dispatch; }
	dispatch(request: TeamSendRequest): Promise<SendPromptResult> {
		if (!this.dispatchMessage) throw new Error("Team messaging service unavailable");
		return this.dispatchMessage(request);
	}
	private commit(next: Data): void {
		if (this.directory) {
			mkdirSync(this.directory, { recursive: true });
			const path = join(this.directory, "team-workspace.json"), tmp = `${path}.tmp`;
			try { writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 }); renameSync(tmp, path); }
			catch (error) { rmSync(tmp, { force: true }); throw error; }
		}
		this.data = next;
		for (const listener of this.listeners) listener();
	}
	snapshot(): TeamWorkspaceSnapshot { return structuredClone({ ...this.data, team: currentTeamSettings() }); }
	room(id: string): TeamRoom | undefined { return structuredClone(this.data.rooms.find(room => room.id === id)); }
	bind(id: string, session: NonNullable<TeamRoom["session"]>): void {
		this.commit({ ...this.data, rooms: this.data.rooms.map(room => room.id === id ? { ...room, session } : room) });
	}
	setModel(id: string, modelKey: string): void { this.commit({ ...this.data, rooms: this.data.rooms.map(room => room.id === id ? { ...room, modelKey } : room) }); }
	saveRoomFromAgent(room: TeamRoom): TeamRoom { return this.action({ type: "room.save", room }, true) as TeamRoom; }
	action(action: TeamWorkspaceAction, allowBusy = false): TeamRoom | TeamMemory | undefined {
		if (action.type === "room.save") {
			const team = currentTeamSettings(), input = action.room;
			const ids = new Set(team.members.map(member => member.id));
			if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 80 || !Array.isArray(input.members) || !input.members.length || input.members.some(id => !ids.has(id)) || new Set(input.members).size !== input.members.length || !input.members.includes(input.adminId) || !["admin", "everyone"].includes(input.mode) || typeof input.notice !== "string" || input.notice.length > 8000 || typeof input.cwd !== "string" || (input.cwd && !isAbsolute(input.cwd))) throw new Error("Invalid group settings");
			const previous = input.id ? this.room(input.id) : undefined;
			if (input.id && !previous) throw new Error("Group not found");
			if (previous && !allowBusy && this.busy(previous.id)) throw new Error("Stop the group before editing it");
			if (input.direct !== undefined && typeof input.direct !== "boolean") throw new Error("Invalid conversation type");
			if (input.direct && input.members.length !== 1) throw new Error("A private chat has exactly one member");
			const room: TeamRoom = { id: previous?.id ?? randomUUID(), name: input.name.trim(), members: [...input.members], adminId: input.adminId, mode: input.mode, notice: input.notice, cwd: input.cwd, modelKey: previous?.modelKey, direct: input.direct, session: previous?.cwd === input.cwd ? previous.session : undefined, createdAt: previous?.createdAt ?? Date.now() };
			this.commit({ ...this.data, rooms: [...this.data.rooms.filter(entry => entry.id !== room.id), room] });
			return room;
		}
		if (action.type === "room.delete") {
			if (this.busy(action.id)) throw new Error("Stop the group before deleting it");
			this.commit({ ...this.data, rooms: this.data.rooms.filter(room => room.id !== action.id), posts: this.data.posts.filter(post => post.roomId !== action.id), memory: this.data.memory.filter(entry => entry.scope !== `room:${action.id}`) });
			return;
		}
		if (action.type === "memory.save") {
			if (typeof action.scope !== "string" || !this.validScope(action.scope) || typeof action.topic !== "string" || !action.topic.trim() || action.topic.length > 120 || typeof action.text !== "string" || !action.text.trim() || action.text.length > 16000) throw new Error("Invalid memory");
			const previous = action.id ? this.data.memory.find(entry => entry.id === action.id) : undefined;
			if (action.id && (!previous || previous.scope !== action.scope)) throw new Error("Memory not found in this scope");
			const entry: TeamMemory = { id: previous?.id ?? randomUUID(), scope: action.scope, topic: action.topic.trim(), text: action.text.trim(), updatedAt: Date.now() };
			this.commit({ ...this.data, memory: [...this.data.memory.filter(item => item.id !== entry.id), entry] });
			return entry;
		}
		if (action.type === "memory.delete") {
			this.commit({ ...this.data, memory: this.data.memory.filter(entry => entry.id !== action.id) });
			return;
		}
		throw new Error("Unknown team action");
	}
	private validScope(scope: string): boolean {
		return scope === "team" || currentTeamSettings().members.some(member => scope === `member:${member.id}`) || this.data.rooms.some(room => scope === `room:${room.id}`);
	}
	posts(roomId: string, limit = 40): TeamPost[] { return this.data.posts.filter(post => post.roomId === roomId).slice(-limit); }
	post(post: Omit<TeamPost, "id" | "at">): string {
		const id = randomUUID();
		this.commit({ ...this.data, posts: [...this.data.posts, { ...post, id, at: Date.now() }].slice(-4000) });
		return id;
	}
	updatePost(id: string, text: string, status: NonNullable<TeamPost["status"]>): void {
		const posts = this.data.posts.map(post => post.id === id ? { ...post, text, status } : post);
		if (status === "streaming") { this.data = { ...this.data, posts }; this.changed(); }
		else this.commit({ ...this.data, posts });
	}
	memories(scopes: string[], query = ""): TeamMemory[] {
		return this.data.memory.filter(entry => scopes.includes(entry.scope) && `${entry.topic} ${entry.text}`.toLowerCase().includes(query.toLowerCase()));
	}
	start(work: Pick<TeamWork, "id" | "roomId" | "memberId" | "task">): void {
		const now = Date.now();
		this.commit({ ...this.data, work: [...this.data.work.filter(item => item.id !== work.id), { ...work, status: "working" as const, text: "", startedAt: now, updatedAt: now }].slice(-300) });
	}
	finish(id: string, status: TeamWork["status"], text: string): void {
		this.cancellers.delete(id);
		this.commit({ ...this.data, work: this.data.work.map(work => work.id === id ? { ...work, status, text, tool: undefined, updatedAt: Date.now() } : work) });
	}
	progress(id: string, delta: string, tool?: string): void {
		const work = this.data.work.find(work => work.id === id);
		if (!work || work.status !== "working") return;
		if (delta) work.text = (work.text + delta).slice(-32000);
		work.tool = tool;
		work.updatedAt = Date.now();
		for (const listener of this.listeners) listener();
	}
	cancellable(id: string, memberId: string, roomId: string, stop: () => void): void { this.cancellers.set(id, { memberId, roomId, stop }); }
	stop(memberId?: string, roomId?: string): void {
		for (const entry of this.cancellers.values()) if ((!memberId || entry.memberId === memberId) && (!roomId || entry.roomId === roomId)) entry.stop();
	}
	busy(roomId: string): boolean { return this.data.work.some(work => work.roomId === roomId && work.status === "working"); }
	reconcileRoster(): void {
		const team = currentTeamSettings(), ids = new Set(team.members.map(member => member.id));
		const rooms = this.data.rooms.map(room => {
			const members = room.members.filter(id => ids.has(id));
			return { ...room, members, adminId: members.includes(room.adminId) ? room.adminId : members[0] ?? "" };
		}).filter(room => room.members.length);
		for (const work of this.data.work) if (work.status === "working" && !ids.has(work.memberId)) this.cancellers.get(work.id)?.stop();
		if (JSON.stringify(rooms) !== JSON.stringify(this.data.rooms)) this.commit({ ...this.data, rooms });
		else this.changed();
	}
}

let workspace = new TeamWorkspaceStore();
export function configureTeamWorkspace(store: TeamWorkspaceStore): void { workspace = store; }
export function teamWorkspace(): TeamWorkspaceStore { return workspace; }
