import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isTeamMember, type TeamMember, type TeamSettings } from "../../shared/team";
import { currentTeamSettings, updateTeamSettings } from "../team-settings";
import { teamWorkspace } from "../team-workspace-store";

export interface TeamToolContext {
	team: TeamSettings;
	member: TeamMember;
	roomId: string;
	modelKey: string;
	models?: () => string[];
	message(member: TeamMember, text: string): Promise<string>;
	stop(memberId: string): Promise<void>;
}

/** Native PI tools implementing the roster, group and memory capabilities of DS Bot. */
export function teamTools(context: TeamToolContext): ToolDefinition[] {
	const workspace = teamWorkspace();
	const main = () => {
		const team = currentTeamSettings();
		return team.adminId === context.member.id || team.members.find(member => member.id === context.member.id)?.main === true;
	};
	const memberOf = (name?: string) => {
		const member = currentTeamSettings().members.find(member => name ? member.name.toLowerCase() === name.replace(/^@/, "").toLowerCase() || member.id === name : member.id === context.member.id);
		if (!member) throw new Error(`Unknown teammate: ${name}`);
		return member;
	};
	const mutate = (change: (team: TeamSettings) => TeamSettings) => {
		const next = updateTeamSettings(change);
		Object.assign(context.team, next);
		return next;
	};
	const tool = (name: string, description: string, parameters: ToolDefinition["parameters"], run: (args: any) => unknown | Promise<unknown>): ToolDefinition => ({
		name, label: name, description, parameters,
		execute: async (_id, args) => {
			try {
				const result = await run(args);
				return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: { error: true } };
			}
		},
	});
	const editable = (name?: string) => {
		const member = memberOf(name);
		if (member.id !== context.member.id && !main()) throw new Error("Only a Main Bot can change another member");
		return member;
	};
	const scopeOf = (scope?: string, writing = false) => {
		if (!scope || scope === "own") return `member:${context.member.id}`;
		if (scope === "group") {
			const room = workspace.room(context.roomId);
			if (!room || room.direct || !room.members.includes(context.member.id)) throw new Error("This conversation has no accessible group memory");
			return `room:${context.roomId}`;
		}
		if (scope === "team") { if (writing && !main()) throw new Error("Only a Main Bot can write team memory"); return "team"; }
		const member = writing ? editable(scope) : memberOf(scope);
		return `member:${member.id}`;
	};
	const tools = [
		tool("list_bots", "List team members, their current work, and accessible group chats.", Type.Object({}), () => {
			const state = workspace.snapshot();
			return { members: state.team.members.map(member => ({ ...member, main: member.id === state.team.adminId || member.main, work: state.work.filter(work => work.memberId === member.id && work.status === "working") })), groups: state.rooms.filter(room => !room.direct && (main() || room.members.includes(context.member.id))) };
		}),
		tool("list_models", "List configured available provider/model identifiers for member model selection.", Type.Object({}), () => context.models?.() ?? [...new Set([context.modelKey, ...currentTeamSettings().members.map(member => member.modelKey).filter(Boolean)])]),
		tool("create_bot", "Main Bot only: create a persistent teammate. You can immediately assign it work with team_assign or message_bot. Never create duplicate roles unnecessarily.", Type.Object({
			name: Type.String({ minLength: 1, maxLength: 32 }), role: Type.String({ maxLength: 60 }), instructions: Type.String({ maxLength: 8000 }),
			model: Type.Optional(Type.String()), effort: Type.Optional(Type.String()), access: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("read-only")])),
		}), args => {
			if (!main()) throw new Error("Only a Main Bot can create members");
			const member: TeamMember = { id: `m-${randomUUID()}`, name: args.name.trim(), role: args.role, instructions: args.instructions, modelKey: args.model ?? context.modelKey, thinkingLevel: args.effort ?? context.member.thinkingLevel, access: args.access ?? "full" };
			if (!isTeamMember(member)) throw new Error("Invalid member settings");
			if (member.modelKey && context.models && !context.models().includes(member.modelKey)) throw new Error("Model is unavailable; call list_models");
			mutate(team => ({ ...team, members: [...team.members, member] }));
			const room = workspace.room(context.roomId);
			if (room && !room.direct) workspace.saveRoomFromAgent({ ...room, members: [...room.members, member.id] });
			workspace.post({ roomId: context.roomId, memberId: context.member.id, name: context.member.name, kind: "notice", text: `Created @${member.name} — ${member.role}` });
			return { created: member, message: "Member saved. It can receive work immediately." };
		}),
		tool("update_bot", "Change your own profile. Main Bots may also change another member. Main privileges and deletion remain user-controlled.", Type.Object({
			bot: Type.Optional(Type.String()), name: Type.Optional(Type.String()), role: Type.Optional(Type.String()), instructions: Type.Optional(Type.String()), model: Type.Optional(Type.String()), effort: Type.Optional(Type.String()),
		}), args => {
			const member = editable(args.bot);
			const next = { ...member, ...(args.name !== undefined ? { name: args.name.trim() } : {}), ...(args.role !== undefined ? { role: args.role } : {}), ...(args.instructions !== undefined ? { instructions: args.instructions } : {}), ...(args.model !== undefined ? { modelKey: args.model } : {}), ...(args.effort !== undefined ? { thinkingLevel: args.effort } : {}) };
			if (!isTeamMember(next)) throw new Error("Invalid member settings");
			if (next.modelKey && context.models && !context.models().includes(next.modelKey)) throw new Error("Model is unavailable; call list_models");
			mutate(team => ({ ...team, members: team.members.map(entry => entry.id === member.id ? next : entry) }));
			return `Updated @${next.name}. Changes apply on its next task.`;
		}),
		tool("message_bot", "Ask a teammate a self-contained question or task and receive its report. In a group, only call group members. Do not call a member waiting for your report.", Type.Object({ to: Type.String(), message: Type.String({ minLength: 1 }) }), async args => {
			const member = memberOf(args.to), room = workspace.room(context.roomId);
			if (member.id === context.member.id) throw new Error("You cannot message yourself");
			if (room && !room.direct && !room.members.includes(member.id)) throw new Error("Add the member to this group first with update_group");
			return context.message(member, args.message);
		}),
		tool("stop_bot", "Stop a currently running teammate. Main Bots can stop any teammate; other members can stop only themselves.", Type.Object({ bot: Type.String() }), async args => {
			const member = editable(args.bot); await context.stop(member.id); return `Stopped @${member.name}`;
		}),
		tool("remember", "Save a durable fact or decision. Scopes: own (default), group, team (Main Bot only), or another member's name (Main Bot only).", Type.Object({ topic: Type.String(), text: Type.String(), scope: Type.Optional(Type.String()) }), args => workspace.action({ type: "memory.save", scope: scopeOf(args.scope, true), topic: args.topic, text: args.text })),
		tool("recall", "Search durable memories. Read your own, team, group, or another member's memory by name.", Type.Object({ query: Type.Optional(Type.String()), scope: Type.Optional(Type.String()) }), args => workspace.memories(args.scope ? [scopeOf(args.scope)] : [`member:${context.member.id}`, "team", `room:${context.roomId}`], args.query ?? "")),
		tool("forget", "Remove a memory by id. You may change your own memory; a Main Bot may change other members' and team memory.", Type.Object({ id: Type.String() }), args => {
			const entry = workspace.snapshot().memory.find(entry => entry.id === args.id);
			if (!entry) throw new Error("Memory not found");
			const room = workspace.room(context.roomId);
			if (entry.scope !== `member:${context.member.id}` && !(entry.scope === `room:${context.roomId}` && room?.members.includes(context.member.id)) && !main()) throw new Error("You cannot change another member's memory");
			workspace.action({ type: "memory.delete", id: args.id }); return "Memory removed";
		}),
		tool("read_own_chat", "Read recent messages in your own private chat, including while working in a group.", Type.Object({ query: Type.Optional(Type.String()) }), args => {
			const own = workspace.snapshot().rooms.find(room => room.direct && room.members.includes(context.member.id));
			return workspace.posts(own?.id ?? context.roomId, 80).filter(post => !args.query || post.text.toLowerCase().includes(args.query.toLowerCase()));
		}),
		tool("read_group_chat", "Read an accessible group's recent messages.", Type.Object({ group: Type.String(), query: Type.Optional(Type.String()) }), args => {
			const room = workspace.snapshot().rooms.find(room => !room.direct && (room.id === args.group || room.name === args.group));
			if (!room || (!main() && !room.members.includes(context.member.id))) throw new Error("Group is not accessible");
			return workspace.posts(room.id, 80).filter(post => !args.query || post.text.toLowerCase().includes(args.query.toLowerCase()));
		}),
		tool("create_group", "Create a persistent group of existing members. Include an admin to coordinate it.", Type.Object({ name: Type.String(), members: Type.Array(Type.String(), { minItems: 1 }), admin: Type.String(), notice: Type.Optional(Type.String()), mode: Type.Optional(Type.Union([Type.Literal("admin"), Type.Literal("everyone")])) }), args => {
			const members = [...new Set<string>([context.member.id, ...args.members.map((name: string) => memberOf(name).id)])];
			return workspace.action({ type: "room.save", room: { name: args.name, members, adminId: memberOf(args.admin).id, mode: args.mode ?? "admin", notice: args.notice ?? "", cwd: workspace.room(context.roomId)?.cwd ?? "" } });
		}),
		tool("post_to_group", "Post a self-contained message to an accessible group and start its members. Results are asynchronous; read_group_chat retrieves them. For your current group, call named members with message_bot instead.", Type.Object({ group: Type.String(), message: Type.String({ minLength: 1 }) }), async args => {
			const room = workspace.snapshot().rooms.find(room => !room.direct && (room.id === args.group || room.name === args.group));
			if (!room || (!main() && !room.members.includes(context.member.id))) throw new Error("Group is not accessible");
			if (room.id === context.roomId) throw new Error("You are already in this group. Use message_bot to call a member, or reply here.");
			const result = await workspace.dispatch({ roomId: room.id, text: `Message from @${context.member.name}:\n${args.message}`, modelKey: context.modelKey });
			if (!result.accepted) throw new Error(result.error);
			return `Posted to ${room.name}. The group is working; use read_group_chat to check its reports.`;
		}),
		tool("search_chats", "Search messages in accessible group chats and your private chat.", Type.Object({ query: Type.String({ minLength: 1 }) }), args => {
			const state = workspace.snapshot();
			const ids = new Set(state.rooms.filter(room => room.direct ? room.members.includes(context.member.id) : main() || room.members.includes(context.member.id)).map(room => room.id));
			return state.posts.filter(post => ids.has(post.roomId) && post.text.toLowerCase().includes(args.query.toLowerCase())).slice(-50);
		}),
		tool("update_group", "Main Bot or group admin: change group membership, notice, name or reply mode.", Type.Object({ group: Type.String(), name: Type.Optional(Type.String()), members: Type.Optional(Type.Array(Type.String())), admin: Type.Optional(Type.String()), notice: Type.Optional(Type.String()), mode: Type.Optional(Type.Union([Type.Literal("admin"), Type.Literal("everyone")])) }), args => {
			const room = workspace.snapshot().rooms.find(room => !room.direct && (room.id === args.group || room.name === args.group));
			if (!room || (!main() && room.adminId !== context.member.id)) throw new Error("Only a Main Bot or group admin can edit this group");
			return workspace.saveRoomFromAgent({ ...room, name: args.name ?? room.name, members: args.members ? args.members.map((name: string) => memberOf(name).id) : room.members, adminId: args.admin ? memberOf(args.admin).id : room.adminId, notice: args.notice ?? room.notice, mode: args.mode ?? room.mode });
		}),
	];
	return tools;
}
