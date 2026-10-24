import { existsSync, statSync } from "node:fs";
import type { TeamSendRequest } from "../shared/team-workspace";
import type { SendPromptResult } from "../shared/agent";
import type { TaskManager } from "./task-manager";
import type { TeamWorkspaceStore } from "./team-workspace-store";

/** Each group/private chat owns a normal durable PI session, independent of desktop selection. */
export class TeamWorkspaceService {
	private readonly opening = new Set<string>();
	constructor(private readonly store: TeamWorkspaceStore, private readonly tasks: () => TaskManager) { store.setDispatcher(request => this.send(request)); }
	async send(request: TeamSendRequest): Promise<SendPromptResult> {
		if (!request || typeof request.roomId !== "string" || typeof request.text !== "string" || !request.text.trim() || request.text.length > 100000 || (request.modelKey !== undefined && typeof request.modelKey !== "string")) throw new Error("Invalid team message");
		if (this.opening.has(request.roomId) || this.store.busy(request.roomId)) throw new Error("This conversation is already working");
		this.opening.add(request.roomId);
		let createdSessionFile: string | undefined;
		let accepted = false;
		try {
			const room = this.store.room(request.roomId);
			if (!room) throw new Error("Group not found");
			if (!statSync(room.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error("Choose an existing working folder for this conversation");
			const tasks = this.tasks();
			const reopening = !!room.session && existsSync(room.session.sessionFile);
			const agent = reopening && room.session
				? await tasks.open({ cwd: room.cwd, sessionFile: room.session.sessionFile }, false)
				: await tasks.create(room.cwd, false);
			const snapshot = agent.getSnapshot();
			if (!snapshot) throw new Error("Team session unavailable");
			if (!reopening) createdSessionFile = snapshot.session.sessionFile;
			if (snapshot.streaming) throw new Error("This conversation is already working");
			const modelKey = request.modelKey || room.modelKey || snapshot.modelKey || this.store.snapshot().team.members.find(member => member.id === room.adminId)?.modelKey;
			if (!modelKey) throw new Error("Configure a chat model first");
			await agent.setFusion({ strategy: "team", orchestration: "engine", teamRoomId: room.id, leadModelKey: modelKey, sidekickModelKey: modelKey, leadThinkingLevel: "medium", sidekickThinkingLevel: "low", adaptiveRouting: false });
			const result = await agent.send({ text: request.text.trim() });
			if (result.accepted) {
				accepted = true;
				this.store.bind(room.id, { id: snapshot.session.id, sessionFile: snapshot.session.sessionFile });
				this.store.setModel(room.id, modelKey);
			}
			return result;
		} finally {
			if (!accepted && createdSessionFile) await this.tasks().remove(createdSessionFile).catch(() => undefined);
			this.opening.delete(request.roomId);
		}
	}
	async stop(roomId: string, memberId?: string): Promise<void> {
		this.store.stop(memberId, roomId);
		const room = this.store.room(roomId);
		if (!memberId && room?.session) await this.tasks().abortSession(room.session.id);
	}
}
