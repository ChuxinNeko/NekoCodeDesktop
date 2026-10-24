import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEAM, type TeamSettings } from "../../src/shared/team";
import { configureTeamSettings } from "../../src/main/team-settings";
import { configureTeamWorkspace, TeamWorkspaceStore } from "../../src/main/team-workspace-store";
import { TeamWorkspaceService } from "../../src/main/team-workspace-service";
import { teamTools } from "../../src/main/fusion/team-tools";
import type { TeamRoom } from "../../src/shared/team-workspace";
import type { TaskManager } from "../../src/main/task-manager";

const directories: string[] = [];
function fixture(durable = false) {
	let team: TeamSettings = structuredClone(DEFAULT_TEAM);
	configureTeamSettings(() => team, next => { team = next; });
	const dir = mkdtempSync(join(tmpdir(), "neko-team-")); directories.push(dir);
	const store = new TeamWorkspaceStore(durable ? dir : undefined);
	configureTeamWorkspace(store);
	const room = store.action({ type: "room.save", room: { name: "Build", members: team.members.map(member => member.id), adminId: "chief", mode: "admin", cwd: dir, notice: "Verified work only" } }) as TeamRoom;
	const invoke = async (memberId: string, name: string, args: unknown) => {
		const tools = teamTools({ team, member: team.members.find(member => member.id === memberId)!, roomId: room.id, modelKey: "test/model", models: () => ["test/model"], message: async (target, text) => `${target.name}: ${text}`, stop: async () => {} });
		const result = await tools.find(tool => tool.name === name)!.execute("call", args as never, new AbortController().signal, undefined, {} as never);
		return JSON.stringify(result);
	};
	return { store, room, dir, invoke, team: () => team };
}
afterEach(() => {
	configureTeamSettings(() => undefined); configureTeamWorkspace(new TeamWorkspaceStore());
	for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("persistent team workspace", () => {
	test("groups, session bindings, posts and memory survive restart; interrupted work becomes stopped", () => {
		const { store, room, dir } = fixture(true);
		store.bind(room.id, { id: "session", sessionFile: join(dir, "session.jsonl") });
		store.post({ roomId: room.id, memberId: "coder", name: "Coder", text: "Implemented", kind: "message" });
		store.action({ type: "memory.save", scope: "member:coder", topic: "tests", text: "Use Bun" });
		store.start({ id: "run", memberId: "coder", roomId: room.id, task: "Implement" });
		const reopened = new TeamWorkspaceStore(dir).snapshot();
		expect(reopened.rooms[0].session?.id).toBe("session");
		expect(reopened.posts[0].text).toBe("Implemented");
		expect(reopened.memory[0].text).toBe("Use Bun");
		expect(reopened.work[0].status).toBe("stopped");
	});
	test("invalid group membership and memory scope are rejected before storage changes", () => {
		const { store, room } = fixture();
		expect(() => store.action({ type: "room.save", room: { ...room, members: ["missing"] } })).toThrow("Invalid group");
		expect(() => store.action({ type: "memory.save", scope: "member:missing", topic: "x", text: "y" })).toThrow("Invalid memory");
		expect(store.snapshot().rooms).toHaveLength(1);
	});
	test("busy group editing/deletion is refused; live agent membership edits and member stopping work", () => {
		const { store, room } = fixture();
		store.start({ id: "run", roomId: room.id, memberId: "coder", task: "Build" });
		let stopped = false;
		store.cancellable("run", "coder", room.id, () => { stopped = true; });
		expect(() => store.action({ type: "room.delete", id: room.id })).toThrow("Stop the group");
		expect(() => store.action({ type: "room.save", room: { ...room, notice: "new" } })).toThrow("Stop the group");
		store.saveRoomFromAgent({ ...room, notice: "new" });
		store.stop("reviewer", room.id); expect(stopped).toBe(false);
		store.stop("coder", room.id); expect(stopped).toBe(true);
		store.finish("run", "stopped", "Stopped");
		store.action({ type: "room.delete", id: room.id });
		expect(store.snapshot().rooms).toHaveLength(0);
	});
	test("corrupt JSON falls back to an empty workspace", () => {
		const { dir } = fixture();
		writeFileSync(join(dir, "team-workspace.json"), "broken");
		expect(new TeamWorkspaceStore(dir).snapshot().rooms).toEqual([]);
	});
	test("changing folders detaches the old PI session and deleting members reconciles group membership", () => {
		const { store, room, team } = fixture();
		store.bind(room.id, { id: "old", sessionFile: "old.jsonl" });
		store.setModel(room.id, "test/model");
		store.action({ type: "room.save", room: { ...room, cwd: tmpdir() } });
		expect(store.room(room.id)?.session).toBeUndefined();
		expect(store.room(room.id)?.modelKey).toBe("test/model");
		team().members = team().members.filter(member => member.id !== "coder");
		store.reconcileRoster();
		expect(store.room(room.id)?.members).toEqual(["chief", "reviewer"]);
	});
});

describe("team tool permissions", () => {
	test("only Main Bots create teammates and may edit another profile; duplicate names and invalid models are refused", async () => {
		const { invoke, team } = fixture();
		const args = { name: "Researcher", role: "Research", instructions: "Find evidence" };
		expect(await invoke("coder", "create_bot", args)).toContain("Only a Main Bot");
		expect(await invoke("chief", "create_bot", { ...args, model: "missing/model" })).toContain("Model is unavailable");
		expect(await invoke("chief", "create_bot", args)).toContain("Member saved");
		expect(team().members).toHaveLength(4);
		expect(await invoke("chief", "create_bot", args)).toContain("Invalid team settings");
		expect(await invoke("coder", "update_bot", { bot: "Reviewer", instructions: "Rewrite" })).toContain("Only a Main Bot");
		expect(await invoke("coder", "update_bot", { role: "Lead engineer" })).toContain("Updated @Coder");
	});
	test("all members read memories; only the owner or Main Bot can modify personal memories", async () => {
		const { invoke, store } = fixture();
		expect(await invoke("coder", "remember", { topic: "tests", text: "Use Bun" })).toContain("Use Bun");
		const memory = store.snapshot().memory[0];
		expect(await invoke("reviewer", "recall", { scope: "Coder", query: "Bun" })).toContain("Use Bun");
		expect(await invoke("reviewer", "forget", { id: memory.id })).toContain("cannot change");
		expect(await invoke("coder", "remember", { scope: "team", topic: "policy", text: "Skip checks" })).toContain("Only a Main Bot");
		expect(await invoke("chief", "forget", { id: memory.id })).toContain("Memory removed");
		expect(store.snapshot().memory).toHaveLength(0);
	});
	test("group messages stay inside their membership, and non-admins cannot edit the group", async () => {
		const { store, room, invoke } = fixture();
		store.action({ type: "room.save", room: { ...room, members: ["chief", "coder"] } });
		expect(await invoke("coder", "message_bot", { to: "Reviewer", message: "Review" })).toContain("Add the member");
		expect(await invoke("coder", "update_group", { group: room.id, notice: "New" })).toContain("Only a Main Bot or group admin");
		expect(await invoke("chief", "update_group", { group: room.id, members: ["Chief", "Coder", "Reviewer"] })).toContain("reviewer");
	});
	test("an additional Main Bot may create members without being the default admin", async () => {
		const { invoke, team } = fixture();
		team().members.find(member => member.id === "coder")!.main = true;
		expect(await invoke("coder", "create_bot", { name: "Writer", role: "Docs", instructions: "Write clear docs" })).toContain("Member saved");
	});
});

test("team sends create background sessions, bind them and reuse them without changing desktop selection", async () => {
	const { store, room, dir } = fixture();
	const sessionFile = join(dir, "test.jsonl"); writeFileSync(sessionFile, "");
	let creates = 0, opens = 0;
	const configurations: unknown[] = [];
	const agent = { getSnapshot: () => ({ session: { id: "pi-session", sessionFile }, modelKey: "test/model", streaming: false }), setFusion: async (value: unknown) => { configurations.push(value); }, send: async () => ({ accepted: true }) };
	const tasks = { create: async (_cwd: string, select: boolean) => { expect(select).toBe(false); creates++; return agent; }, open: async (_request: unknown, select: boolean) => { expect(select).toBe(false); opens++; return agent; } };
	const service = new TeamWorkspaceService(store, () => tasks as unknown as TaskManager);
	expect(await service.send({ roomId: room.id, text: "Hello" })).toEqual({ accepted: true });
	expect(store.room(room.id)?.session?.id).toBe("pi-session");
	await service.send({ roomId: room.id, text: "Continue" });
	expect([creates, opens]).toEqual([1, 1]);
	expect(configurations[0]).toMatchObject({ strategy: "team", teamRoomId: room.id, leadModelKey: "test/model" });
});

test("a refused first message cleans up its unused PI session without binding it to the group", async () => {
	const { store, room, dir } = fixture();
	const removed: string[] = [];
	const sessionFile = join(dir, "unused.jsonl");
	const agent = { getSnapshot: () => ({ session: { id: "unused", sessionFile }, modelKey: "test/model", streaming: false }), setFusion: async () => {}, send: async () => ({ accepted: false, error: "Not configured" }) };
	const tasks = { create: async () => agent, remove: async (file: string) => { removed.push(file); } };
	const service = new TeamWorkspaceService(store, () => tasks as unknown as TaskManager);
	expect(await service.send({ roomId: room.id, text: "Hello" })).toEqual({ accepted: false, error: "Not configured" });
	expect(removed).toEqual([sessionFile]);
	expect(store.room(room.id)?.session).toBeUndefined();
});
