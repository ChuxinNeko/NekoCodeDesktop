import type { TeamSettings } from "./team";

export interface TeamRoom {
	id: string;
	name: string;
	members: string[];
	adminId: string;
	mode: "admin" | "everyone";
	notice: string;
	cwd: string;
	modelKey?: string;
	direct?: boolean;
	session?: { id: string; sessionFile: string };
	createdAt: number;
}
export interface TeamPost {
	workId?: string;
	status?: "streaming" | "done" | "failed";
	id: string;
	roomId: string;
	memberId: string;
	name: string;
	text: string;
	kind: "message" | "assignment" | "notice";
	at: number;
}
export interface TeamMemory {
	id: string;
	scope: string;
	topic: string;
	text: string;
	updatedAt: number;
}
export interface TeamWork {
	id: string;
	roomId: string;
	memberId: string;
	task: string;
	status: "working" | "done" | "failed" | "stopped";
	text: string;
	tool?: string;
	startedAt: number;
	updatedAt: number;
}
export interface TeamWorkspaceSnapshot {
	team: TeamSettings;
	rooms: TeamRoom[];
	posts: TeamPost[];
	memory: TeamMemory[];
	work: TeamWork[];
}
export type TeamWorkspaceAction =
	| { type: "room.save"; room: Omit<TeamRoom, "id" | "createdAt" | "session"> & { id?: string } }
	| { type: "room.delete"; id: string }
	| { type: "memory.save"; scope: string; topic: string; text: string; id?: string }
	| { type: "memory.delete"; id: string };

export interface TeamSendRequest { roomId: string; text: string; modelKey?: string }
