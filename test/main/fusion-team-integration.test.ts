import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, getCurrentSystemPrompt, type ToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowSession } from "../../src/main/workflow-runtime";
import { configureTeamSettings } from "../../src/main/team-settings";
import { DEFAULT_TEAM, isTeamSettings, mentionedMembers, TEAM_AVATAR_COLORS, TEAM_AVATAR_SHAPES, teamAvatarOf, type TeamSettings } from "../../src/shared/team";

type Script = (stage: string, n: number, context: string) => ToolCall | string;
const chat = "anthropic/claude-opus-4-5", cheap = "anthropic/claude-sonnet-4-5";
const TEAM: TeamSettings = { ...DEFAULT_TEAM, parallel: true, members: DEFAULT_TEAM.members.map(member => member.id === "coder" ? { ...member, modelKey: cheap } : member) };

async function scenario(prompts: string[], script: Script, check: (result: { cwd: string; stages: string[]; models: string[];
	created: Awaited<ReturnType<typeof createWorkflowSession>>; manager: SessionManager; tools: Map<string, string[]> }) => Promise<void>, team = TEAM) {
	configureTeamSettings(() => team);
	const cwd = await mkdtemp(join(tmpdir(), "fusion-team-"));
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
			const call = typeof out === "string" ? undefined : out;
			queueMicrotask(() => stream.push({ type: "done", reason: call ? "toolUse" : "stop", message: {
				...fauxAssistantMessage(""), api: model.api, provider: model.provider, model: model.id,
				content: call ? [call] : [{ type: "text", text: out as string }], stopReason: call ? "toolUse" : "stop",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
			return stream;
		};
		const manager = SessionManager.inMemory(cwd);
		created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime, sessionManager: manager,
			initialMode: "agent", getPermission: () => "auto", initialFusion: { strategy: "team", leadModelKey: chat, sidekickModelKey: chat,
				leadThinkingLevel: "off", sidekickThinkingLevel: "off", adaptiveRouting: false },
			onChange: () => undefined, onModeChange: () => undefined });
		for (const prompt of prompts) await created.session.prompt(prompt);
		await check({ cwd, stages, models, created, manager, tools });
	} finally { created?.workflow.dispose(); created?.session.dispose(); await created?.workflow.whenSettled(); await rm(cwd, { recursive: true, force: true }); }
}
const assign = (assignments: { member: string; task: string }[]): ToolCall => ({ type: "toolCall", id: `assign-${assignments.length}`, name: "team_assign", arguments: { assignments } });
const assistants = (manager: SessionManager) => manager.getBranch().flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []);

afterEach(() => configureTeamSettings(() => undefined));

describe("AI team strategy", () => {
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
});
