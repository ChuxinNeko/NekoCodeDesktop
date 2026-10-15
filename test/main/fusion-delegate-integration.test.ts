import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, getCurrentSystemPrompt, type ToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowSession } from "../../src/main/workflow-runtime";
import { unifiedDiff } from "../../src/main/fusion/change-tracker";

type Script = (stage: string, n: number, context: string) => ToolCall | string;
async function scenario(script: Script, check: (result: { cwd: string; stages: string[]; created: Awaited<ReturnType<typeof createWorkflowSession>>;
	manager: SessionManager; tools: Map<string, string[]> }) => Promise<void>) {
	const cwd = await mkdtemp(join(tmpdir(), "fusion-delegate-"));
	let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
	try {
		await writeFile(join(cwd, "a.txt"), "start\n");
		const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
		await runtime.setRuntimeApiKey("anthropic", "test-only");
		const lead = getModel("anthropic", "claude-opus-4-5")!, side = getModel("anthropic", "claude-sonnet-4-5")!;
		const stages: string[] = []; const counts = new Map<string, number>(); const tools = new Map<string, string[]>();
		runtime.streamSimple = (model, context) => {
			const system = getCurrentSystemPrompt(context.messages);
			const stage = system.includes("cost-aware pair") ? "brief" : system.includes("Lead reviewer") ? "review" :
				system.includes("finishing a task a Sidekick started") ? "takeover" : model.id === lead.id ? "lead" : "sidekick";
			expect(model.id).toBe(stage === "sidekick" ? side.id : lead.id);
			stages.push(stage);
			const systemMessage = [...context.messages].reverse().find(message => message.role === "system") as { toolsAdded?: { name: string }[] } | undefined;
			tools.set(stage, (systemMessage?.toolsAdded ?? []).map(tool => tool.name));
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
			initialMode: "agent", getPermission: () => "auto", initialFusion: { leadModelKey: `${lead.provider}/${lead.id}`,
				sidekickModelKey: `${side.provider}/${side.id}`, leadThinkingLevel: "off", sidekickThinkingLevel: "off" },
			onChange: () => undefined, onModeChange: () => undefined });
		await created.session.prompt("Put the word right into a.txt.");
		await check({ cwd, stages, created, manager, tools });
	} finally { created?.workflow.dispose(); created?.session.dispose(); await created?.workflow.whenSettled(); await rm(cwd, { recursive: true, force: true }); }
}
const write = (id: string, content: string): ToolCall => ({ type: "toolCall", id, name: "write", arguments: { path: "a.txt", content } });
const brief = (route = "delegate"): ToolCall => ({ type: "toolCall", id: "brief", name: "fusion_submit_brief", arguments: {
	route, complexity: 0.3, brief: "1. a.txt must contain exactly 'right'.", reviewFocus: "exact content" } });
const review = (verdict: string, issues: string[] = [], answer = ""): ToolCall => ({ type: "toolCall", id: `review-${verdict}`, name: "fusion_submit_review", arguments: { verdict, issues, answer } });
const lastAssistant = (manager: SessionManager) => manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant").at(-1);

describe("Fusion delegate strategy", () => {
	test("Lead briefs, Sidekick implements, Lead reviews a diff, the same Sidekick fixes, Lead accepts", () => scenario((stage, n, context) => {
		if (stage === "brief") return brief();
		if (stage === "sidekick") {
			if (n === 1) { expect(context).toContain("a.txt must contain exactly"); return write("w1", "wrong\n"); }
			if (n === 2) return "REPORT_ONE";
			// Persistent actor: the fix round still sees its own first report.
			if (n === 3) { expect(context).toContain("REPORT_ONE"); expect(context).toContain("must say right"); return write("w2", "right\n"); }
			return "REPORT_TWO";
		}
		if (stage === "review" && n === 1) { expect(context).toContain("+wrong"); expect(context).toContain("-start"); return review("revise", ["a.txt must say right"]); }
		if (stage === "review") { expect(context).toContain("+right"); expect(context).toContain("REPORT_TWO"); return review("accept", [], "FINAL_ANSWER"); }
		throw new Error(`unexpected stage ${stage}`);
	}, async ({ cwd, stages, created, manager, tools }) => {
		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("right\n");
		expect(stages).toEqual(["brief", "sidekick", "sidekick", "review", "sidekick", "sidekick", "review"]);
		expect(tools.get("brief")).toEqual(["fusion_submit_brief"]);
		expect(tools.get("review")).toContain("fusion_submit_review"); expect(tools.get("review")).not.toContain("write");
		const last = lastAssistant(manager);
		expect(last?.type === "message" && last.message.role === "assistant" && last.message.model).toBe("claude-opus-4-5");
		expect(JSON.stringify(last)).toContain("FINAL_ANSWER");
		expect(created.workflow.state.snapshot().fusion?.status).toBe("complete");
		expect(manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
	}), 10000);

	test("runs ordered work items on one Sidekick actor before a single review", () => scenario((stage, n, context) => {
		if (stage === "brief") return { type: "toolCall", id: "brief", name: "fusion_submit_brief", arguments: { route: "delegate", complexity: 0.5,
			brief: "1. a.txt says right. 2. b.txt says done.", workItems: ["R1: write a.txt", "R2: write b.txt"], reviewFocus: "" } };
		if (stage === "sidekick") {
			if (n === 1) { expect(context).toContain("Work item 1/2"); return write("w1", "right\n"); }
			if (n === 2) return "ITEM_ONE_OK";
			if (n === 3) { expect(context).toContain("ITEM_ONE_OK"); expect(context).toContain("Work item 2/2"); return { type: "toolCall", id: "w2", name: "write", arguments: { path: "b.txt", content: "done\n" } }; }
			return "FINAL_REPORT";
		}
		if (stage === "review") { expect(context).toContain("FINAL_REPORT"); expect(context).toContain("+done"); expect(context).toContain("+right"); return review("accept", [], "ITEMS_OK"); }
		throw new Error(`unexpected stage ${stage}`);
	}, async ({ cwd, stages, manager }) => {
		expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("done\n");
		expect(stages).toEqual(["brief", "sidekick", "sidekick", "sidekick", "sidekick", "review"]);
		expect(JSON.stringify(lastAssistant(manager))).toContain("ITEMS_OK");
	}), 10000);

	test("routes tiny or tool-free tasks to Lead alone", () => scenario((stage, n) => {
		if (stage === "brief") return brief("lead");
		if (stage === "lead") return n === 1 ? write("solo", "right\n") : "SOLO_DONE";
		throw new Error(`unexpected stage ${stage}`);
	}, async ({ cwd, stages, manager }) => {
		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("right\n");
		expect(stages).toEqual(["brief", "lead", "lead"]);
		expect(JSON.stringify(lastAssistant(manager))).toContain("SOLO_DONE");
	}), 10000);

	test("a capped review is forced to submit a verdict on its last step", () => scenario((stage, n, context) => {
		if (stage === "brief") return brief();
		if (stage === "sidekick") return n === 1 ? write("w1", "right\n") : "REPORT";
		if (stage === "review" && n < 5) { expect(context).not.toContain("Step budget reached"); return { type: "toolCall", id: `r${n}`, name: "read", arguments: { path: "a.txt" } }; }
		if (stage === "review") { expect(context).toContain("Step budget reached. Call fusion_submit_review"); return review("accept", [], "FORCED_ACCEPT"); }
		throw new Error(`unexpected stage ${stage}`);
	}, async ({ stages, manager, tools }) => {
		expect(stages.filter(stage => stage === "review")).toHaveLength(5);
		expect(tools.get("review")).toEqual(["fusion_submit_review"]);
		expect(JSON.stringify(lastAssistant(manager))).toContain("FORCED_ACCEPT");
	}), 10000);

	test("Lead takes over from the diff when review says so", () => scenario((stage, n, context) => {
		if (stage === "brief") return brief();
		if (stage === "sidekick") return n === 1 ? write("w1", "wrong\n") : "REPORT";
		if (stage === "review") return review("takeover", ["content is wrong"]);
		if (stage === "takeover") { if (n === 1) { expect(context).toContain("content is wrong"); expect(context).toContain("+wrong"); return write("fix", "right\n"); } return "TAKEOVER_DONE"; }
		throw new Error(`unexpected stage ${stage}`);
	}, async ({ cwd, stages, manager }) => {
		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("right\n");
		expect(stages).toEqual(["brief", "sidekick", "sidekick", "review", "takeover", "takeover"]);
		expect(JSON.stringify(lastAssistant(manager))).toContain("TAKEOVER_DONE");
	}), 10000);
});

describe("unifiedDiff", () => {
	test("shows changed lines with context and new files", () => {
		const diff = unifiedDiff("x.ts", "a\nb\nc\nd\n", "a\nB\nc\nd\n");
		expect(diff).toContain("-b"); expect(diff).toContain("+B"); expect(diff).toContain(" a");
		expect(unifiedDiff("n.ts", null, "hi")).toContain("+hi");
	});
});
