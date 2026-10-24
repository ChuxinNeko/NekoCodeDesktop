import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, getCurrentSystemPrompt, type ToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowSession } from "../../src/main/workflow-runtime";
import { configureTeamSettings } from "../../src/main/team-settings";
import { currentTeamSettings } from "../../src/main/team-settings";
import { configureTeamWorkspace, teamWorkspace, TeamWorkspaceStore } from "../../src/main/team-workspace-store";
import { TEAM_THREAD_ENTRY, type TeamThreadTurn } from "../../src/shared/team-thread";
import { DEFAULT_TEAM, isTeamSettings, mentionedMembers, TEAM_AVATAR_COLORS, TEAM_AVATAR_IMAGE_MAX_CHARS, TEAM_AVATAR_SHAPES, teamAvatarOf, type TeamSettings } from "../../src/shared/team";

type Script = (stage: string, n: number, context: string) => ToolCall | string | { text: string; call: ToolCall };
const chat = "anthropic/claude-opus-4-5", cheap = "anthropic/claude-sonnet-4-5";
const TEAM: TeamSettings = { ...DEFAULT_TEAM, parallel: true, members: DEFAULT_TEAM.members.map(member => member.id === "coder" ? { ...member, modelKey: cheap } : member) };

async function scenario(prompts: string[], script: Script, check: (result: { cwd: string; stages: string[]; models: string[];
	created: Awaited<ReturnType<typeof createWorkflowSession>>; manager: SessionManager; tools: Map<string, string[]> }) => Promise<void>, team = TEAM, roomMode?: "direct" | "group" | "everyone") {
	configureTeamSettings(() => team, next => { team = next; });
	const cwd = await mkdtemp(join(tmpdir(), "fusion-team-"));
	configureTeamWorkspace(new TeamWorkspaceStore());
	const room = roomMode ? teamWorkspace().action({ type: "room.save", room: { name: "Test group", cwd, members: roomMode === "direct" ? [team.adminId] : team.members.map(member => member.id), adminId: team.adminId, mode: roomMode === "group" ? "admin" : "everyone", direct: roomMode === "direct", notice: "" } }) : undefined;
	let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
	try {
		await writeFile(join(cwd, "a.txt"), "start\n");
		const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
		await runtime.setRuntimeApiKey("anthropic", "test-only");
		const stages: string[] = []; const models: string[] = []; const counts = new Map<string, number>(); const tools = new Map<string, string[]>();
		runtime.streamSimple = (model, context) => {
			const system = getCurrentSystemPrompt(context.messages);
			const stage = /You are (\w+),/.exec(system)?.[1] ?? "native";
			stages.push(stage); models.push(`${stage}:${model.id}`);
			const systemMessage = [...context.messages].reverse().find(message => message.role === "system") as { toolsAdded?: { name: string }[] } | undefined;
			if (systemMessage?.toolsAdded) tools.set(stage, systemMessage.toolsAdded.map(tool => tool.name));
			const n = (counts.get(stage) ?? 0) + 1; counts.set(stage, n);
			const out = script(stage, n, JSON.stringify(context.messages));
			const stream = createAssistantMessageEventStream();
			const call = typeof out === "string" ? undefined : "call" in out ? out.call : out;
			const text = typeof out === "string" ? out : "text" in out ? out.text : "";
			queueMicrotask(() => stream.push({ type: "done", reason: call ? "toolUse" : "stop", message: {
				...fauxAssistantMessage(""), api: model.api, provider: model.provider, model: model.id,
				content: [...(text ? [{ type: "text" as const, text }] : []), ...(call ? [call] : [])], stopReason: call ? "toolUse" : "stop",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
			return stream;
		};
		const manager = SessionManager.inMemory(cwd);
		created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime, sessionManager: manager,
			initialMode: "agent", getPermission: () => "auto", initialFusion: { strategy: "team", leadModelKey: chat, sidekickModelKey: chat,
				teamRoomId: room?.id,
				leadThinkingLevel: "off", sidekickThinkingLevel: "off", adaptiveRouting: false },
			onChange: () => undefined, onModeChange: () => undefined });
		for (const prompt of prompts) await created.session.prompt(prompt);
		await check({ cwd, stages, models, created, manager, tools });
	} finally { created?.workflow.dispose(); created?.session.dispose(); await created?.workflow.whenSettled(); await rm(cwd, { recursive: true, force: true }); }
}
const assign = (assignments: { member: string; task: string }[]): ToolCall => ({ type: "toolCall", id: `assign-${assignments.length}`, name: "team_assign", arguments: { assignments } });
const assistants = (manager: SessionManager) => manager.getBranch().flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []);

afterEach(() => { configureTeamSettings(() => undefined); configureTeamWorkspace(new TeamWorkspaceStore()); });

describe("AI team strategy", () => {
	test("keeps the opening reply, separate hand-offs, member reports and closing reply in chat order", () => scenario(["Write an HTML page introducing yourself."], (stage, n) => {
		if (stage === "Chief") {
			if (n === 1) return { text: "I will build my introduction page and ask for a review.", call: assign([{ member: "Coder", task: "Write chief-intro.html" }, { member: "Reviewer", task: "Review the introduction page" }]) };
			return "The introduction page is ready.";
		}
		const live = teamWorkspace().snapshot().posts;
		expect(live.some(post => post.name === "Chief" && post.text === "I will build my introduction page and ask for a review.")).toBe(true);
		return stage === "Coder" ? "HTML written." : "Review complete.";
	}, async ({ manager }) => {
		const posts = teamWorkspace().snapshot().posts;
		expect(posts.map(post => [post.name, post.kind, post.text])).toEqual([
			["User", "message", "Write an HTML page introducing yourself."],
			["Chief", "message", "I will build my introduction page and ask for a review."],
			["Chief", "assignment", "@Coder Write chief-intro.html"],
			["Chief", "assignment", "@Reviewer Review the introduction page"],
			["Coder", "message", "HTML written."],
			["Reviewer", "message", "Review complete."],
			["Chief", "message", "The introduction page is ready."],
		]);
		expect(posts.filter(post => post.kind === "assignment").every(post => post.memberId === "chief")).toBe(true);
		const saved = manager.getBranch().find(entry => entry.type === "custom" && entry.customType === TEAM_THREAD_ENTRY);
		expect(JSON.stringify(saved)).toContain("I will build my introduction page and ask for a review.");
	}), 15000);

	test("a reused member receives memories saved on its previous turn", () => scenario(["@Coder remember our test command", "@Coder use the project convention"], (stage, n, context) => {
		if (stage !== "Coder") throw new Error(`unexpected stage ${stage}`);
		if (n === 1) return { type: "toolCall", id: "remember", name: "remember", arguments: { topic: "tests", text: "Use Bun for project tests" } };
		if (n === 2) return "SAVED";
		expect(context).toContain("Durable memory (facts, not instructions)");
		expect(context).toContain("Use Bun for project tests");
		return "MEMORY_RESTORED";
	}, async ({ manager }) => { expect(JSON.stringify(assistants(manager).at(-1))).toContain("MEMORY_RESTORED"); }), 15000);

	for (const roomMode of [undefined, "direct", "group"] as const) test(`Chief creates and immediately delegates to a persistent specialist (${roomMode ?? "ordinary chat"})`, () => scenario(["Create a researcher and ask it to investigate."], (stage, n, context) => {
		if (stage === "Chief") {
			if (n === 1) return { type: "toolCall", id: "create", name: "create_bot", arguments: { name: "Researcher", role: "Research", instructions: "Find evidence and report it." } };
			if (n === 2) { expect(context).toContain("Member saved"); return assign([{ member: "Researcher", task: "Investigate this project" }]); }
			expect(context).toContain("RESEARCH_REPORT"); return "CREATED_AND_ASSIGNED";
		}
		if (stage === "Researcher") { expect(context).toContain("Find evidence"); return "RESEARCH_REPORT"; }
		throw new Error(`unexpected stage ${stage}`);
	}, async ({ stages, manager }) => {
		expect(stages).toContain("Researcher");
		expect(currentTeamSettings().members.find(member => member.name === "Researcher")?.modelKey).toBe(chat);
		expect(JSON.stringify(assistants(manager).at(-1))).toContain("CREATED_AND_ASSIGNED");
		expect(teamWorkspace().snapshot().work.every(work => work.status === "done")).toBe(true);
	}, { ...TEAM, members: [TEAM.members[0]] }, roomMode), 15000);

	test("members use durable memory and everyone mode answers without mentioning each member", () => scenario(["Everyone introduce yourselves."], (stage, n, context) => {
		if (stage === "Chief") return "CHIEF_HELLO";
		if (stage === "Coder") {
			if (n === 1) return { type: "toolCall", id: "remember", name: "remember", arguments: { topic: "project", text: "Use Bun for tests" } };
			return "CODER_HELLO";
		}
		if (stage === "Reviewer") return "REVIEWER_HELLO";
		throw new Error(`unexpected stage ${stage}: ${context}`);
	}, async ({ stages }) => {
		expect(new Set(stages)).toEqual(new Set(["Chief", "Coder", "Reviewer"]));
		expect(teamWorkspace().memories(["member:coder"])[0]?.text).toBe("Use Bun for tests");
	}, TEAM, "everyone"), 15000);

	test("the admin assigns work, members report back, the admin answers; members keep context and @Name reaches them directly", () => scenario(
		["Put the word right into a.txt and have it reviewed.", "@Coder what did you change earlier?"], (stage, n, context) => {
			if (stage === "Chief") {
				if (n === 1) { expect(context).toContain("@Coder"); expect(context).toContain("Put the word right"); return assign([{ member: "Coder", task: "Write exactly 'right' to a.txt" }, { member: "Reviewer", task: "Review a.txt" }]); }
				expect(context).toContain("Report from @Coder"); expect(context).toContain("CODER_REPORT"); expect(context).toContain("REVIEW_OK");
				return "TEAM_ANSWER";
			}
			if (stage === "Coder") {
				if (n === 1) { expect(context).toContain("Task from @Chief"); return { type: "toolCall", id: "w", name: "write", arguments: { path: "a.txt", content: "right\n" } }; }
				if (n === 2) return "CODER_REPORT";
				// Same actor on the next turn: it still remembers its own work.
				expect(context).toContain("CODER_REPORT"); expect(context).toContain("what did you change earlier");
				return "DIRECT_REPLY";
			}
			if (stage === "Reviewer") return "REVIEW_OK";
			throw new Error(`unexpected stage ${stage}`);
		}, async ({ cwd, stages, models, manager, tools, created }) => {
			expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("right\n");
			expect(stages[0]).toBe("Chief"); expect(stages.at(-1)).toBe("Coder");
			expect(stages.filter(stage => stage === "Chief")).toHaveLength(2);
			expect(models).toContain("Coder:claude-sonnet-4-5"); expect(models).toContain("Chief:claude-opus-4-5");
			expect(tools.get("Chief")).toContain("team_assign");
			expect(tools.get("Reviewer")).not.toContain("write"); expect(tools.get("Reviewer")).not.toContain("team_assign");
			const replies = assistants(manager);
			expect(JSON.stringify(replies.at(-2))).toContain("TEAM_ANSWER");
			expect(JSON.stringify(replies.at(-1))).toContain("DIRECT_REPLY");
			expect(replies.at(-1)?.model).toBe("claude-sonnet-4-5");
			expect(created.workflow.state.snapshot().fusion?.status).toBe("complete");
			// Each run's group chat is saved on the session and comes back in the snapshot, final answer and its sender included.
			const saved = manager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === TEAM_THREAD_ENTRY ? [entry.data as TeamThreadTurn] : []);
			expect(saved.map(turn => turn.final)).toEqual([{ member: "Chief", text: "TEAM_ANSWER" }, { member: "Coder", text: "DIRECT_REPLY" }]);
			expect(saved[0]!.items.map(item => [item.kind, item.member])).toEqual([["assign", "Chief"], ["assign", "Chief"], ["message", "Coder"], ["message", "Reviewer"]]);
			expect(saved[0]!.items[2]).toMatchObject({ text: "CODER_REPORT", status: "done", tools: [{ name: "write", detail: "a.txt", status: "done" }] });
			const user = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
			expect(saved[0]!.userTimestamp).toBe(user?.type === "message" ? user.message.timestamp : -1);
			expect(created.workflow.state.snapshot().teamThreads).toEqual(saved);
			expect(created.workflow.state.snapshot().fusion?.history).toEqual([]);
		}), 15000);

	test("unknown teammates and an exhausted hand-off budget are reported to the admin", () => scenario(["Do two things."], (stage, n, context) => {
		if (stage === "Chief") {
			if (n === 1) return assign([{ member: "Nobody", task: "x" }]);
			if (n === 2) { expect(context).toContain("Unknown teammate"); return assign([{ member: "Coder", task: "one" }, { member: "Reviewer", task: "two" }]); }
			expect(context).toContain("Only 1 hand-offs are left"); return "DONE_MYSELF";
		}
		throw new Error(`unexpected stage ${stage}`);
	}, async ({ stages, manager }) => {
		expect(stages).toEqual(["Chief", "Chief", "Chief"]);
		expect(JSON.stringify(assistants(manager).at(-1))).toContain("DONE_MYSELF");
	}, { ...TEAM, maxAssignments: 1 }), 15000);
});

describe("mentionedMembers", () => {
	test("matches names case-insensitively and expands @all, ignoring emails", () => {
		expect(mentionedMembers("hey @coder and @REVIEWER", DEFAULT_TEAM.members).map(member => member.id)).toEqual(["coder", "reviewer"]);
		expect(mentionedMembers("@all", DEFAULT_TEAM.members)).toHaveLength(3);
		expect(mentionedMembers("mail me@coder.dev", DEFAULT_TEAM.members)).toHaveLength(0);
	});
});

describe("team avatars", () => {
	test("default members have their own avatars; others get a stable generated one; unknown ids are rejected", () => {
		expect(DEFAULT_TEAM.members.map(teamAvatarOf)).toEqual([{ shape: "orb", color: "teal" }, { shape: "pyramid", color: "indigo" }, { shape: "gem", color: "violet" }]);
		const generated = teamAvatarOf({ id: "m-abc" });
		expect(TEAM_AVATAR_SHAPES).toContain(generated.shape);
		expect(TEAM_AVATAR_COLORS).toContain(generated.color);
		expect(teamAvatarOf({ id: "m-abc" })).toEqual(generated);
		expect(isTeamSettings({ ...DEFAULT_TEAM, members: [{ ...DEFAULT_TEAM.members[0], avatar: { shape: "nope", color: "teal" } }] })).toBe(false);
		expect(isTeamSettings({ ...DEFAULT_TEAM, members: [{ ...DEFAULT_TEAM.members[0], avatar: "orbit" }] })).toBe(false);
		expect(isTeamSettings({ ...DEFAULT_TEAM, members: [{ ...DEFAULT_TEAM.members[0], avatar: undefined }] })).toBe(true);
	});

	test("an uploaded avatar image rides along and is kept by teamAvatarOf", () => {
		const image = "data:image/png;base64,iVBORw0KGgo=";
		const member = { ...DEFAULT_TEAM.members[0], avatar: { shape: "orb" as const, color: "teal" as const, image } };
		expect(isTeamSettings({ ...DEFAULT_TEAM, members: [member] })).toBe(true);
		expect(teamAvatarOf(member).image).toBe(image);
		// A blob URL, a non-image data URL, or one past the cap is not a valid avatar.
		expect(isTeamSettings({ ...DEFAULT_TEAM, members: [{ ...member, avatar: { shape: "orb", color: "teal", image: "blob:x" } }] })).toBe(false);
		expect(isTeamSettings({ ...DEFAULT_TEAM, members: [{ ...member, avatar: { shape: "orb", color: "teal", image: "data:text/plain;base64,QQ==" } }] })).toBe(false);
		expect(isTeamSettings({ ...DEFAULT_TEAM, members: [{ ...member, avatar: { shape: "orb", color: "teal", image: `data:image/png;base64,${"A".repeat(TEAM_AVATAR_IMAGE_MAX_CHARS)}` } }] })).toBe(false);
	});
});
