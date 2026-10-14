import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowSession } from "../../src/main/workflow-runtime";

async function fixture(name: string, failover?: boolean) {
	const cwd = await mkdtemp(join(tmpdir(), name));
	const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
	await runtime.setRuntimeApiKey("anthropic", "test-only");
	await runtime.setRuntimeApiKey("openai", "test-only");
	const lead = getModel("anthropic", "claude-opus-4-5")!;
	const side = getModel("openai", "gpt-5-mini")!;
	return { cwd, runtime, lead, side, initialFusion: { leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${side.provider}/${side.id}`,
		leadThinkingLevel: "off" as const, sidekickThinkingLevel: "off" as const, ...(failover === undefined ? {} : { failover }) } };
}
const reply = (model: any, calls?: ToolCall[]) => {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message: {
		...fauxAssistantMessage("ok"), provider: model.provider, model: model.id, api: model.api, stopReason: calls ? "toolUse" : "stop",
		content: calls ?? [{ type: "text", text: "Lead accepted result.txt" }] } }));
	return stream;
};
const failure = (model: any, error: string) => {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "error", reason: "error", error: { ...fauxAssistantMessage(""), provider: model.provider, model: model.id, api: model.api,
		content: [], stopReason: "error", errorMessage: error } }));
	return stream;
};

describe("Fusion high availability in the inline main conversation", () => {
	test("Sidekick outage: implementation completes on Lead with the Sidekick contract, then Lead accepts", async () => {
		const f = await fixture("fusion-ha-side-");
		let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			const served: string[] = []; const errors: string[] = []; let step = 0;
			f.runtime.streamSimple = (model, _context) => {
				if (model.id === f.side.id) { served.push("side:401"); return failure(model, "401 Incorrect API key provided"); }
				served.push(model.id); step++;
				// Step 1 = Lead plans; 2,3 = Lead model serving Sidekick role; 4 = Lead reviews.
				const calls: ToolCall[] | undefined = step === 1 ? [{ type: "toolCall", id: "impl", name: "fusion_implement", arguments: { instruction: "Write ok", path: "result.txt", acceptanceCriterion: "result.txt contains ok", skipReason: "trivial" } }] :
					step === 2 ? [{ type: "toolCall", id: "w", name: "write", arguments: { path: "result.txt", content: "ok" } }] :
					step === 3 ? [{ type: "toolCall", id: "r", name: "fusion_review", arguments: { outcome: "completed", summary: "wrote result.txt" } }] : undefined;
				return reply(model, calls);
			};
			created = await createWorkflowSession({ cwd: f.cwd, agentDir: join(f.cwd, "agent"), debugRoot: f.cwd, modelRuntime: f.runtime,
				sessionManager: SessionManager.inMemory(f.cwd), initialMode: "agent", getPermission: () => "auto", initialFusion: f.initialFusion,
				onChange: () => undefined, onModeChange: () => undefined, onError: (e) => errors.push(e) });
			await created.session.prompt("Create result.txt containing ok");
			expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("ok");
			// The circuit opened after the first failure: later Sidekick-role requests go straight to Lead.
			expect(served).toEqual([f.lead.id, "side:401", f.lead.id, f.lead.id, f.lead.id]);
			expect(errors.filter((e) => e.includes("自动切换")).length).toBe(1);
			const last = created.session.messages.filter((m) => m.role === "assistant").at(-1) as any;
			expect(last.content[0].text).toBe("Lead accepted result.txt");
			const audit = created.session.sessionManager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "nekocode.fusion.failover.v1");
			expect(audit.map((e: any) => e.data.type)).toEqual(["failover"]);
		} finally { created?.workflow.dispose(); created?.session.dispose(); await rm(f.cwd, { recursive: true, force: true }); }
	}, 30000);

	test("Lead outage: Sidekick keeps the run alive and the degraded Lead turn is flagged", async () => {
		const f = await fixture("fusion-ha-lead-");
		let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			const served: string[] = []; const errors: string[] = [];
			f.runtime.streamSimple = (model) => {
				if (model.id === f.lead.id) { served.push("lead:503"); return failure(model, "503 Service Unavailable"); }
				served.push(model.id); return reply(model);
			};
			created = await createWorkflowSession({ cwd: f.cwd, agentDir: join(f.cwd, "agent"), debugRoot: f.cwd, modelRuntime: f.runtime,
				sessionManager: SessionManager.inMemory(f.cwd), initialMode: "agent", getPermission: () => "auto", initialFusion: f.initialFusion,
				onChange: () => undefined, onModeChange: () => undefined, onError: (e) => errors.push(e) });
			await created.session.prompt("Explain the plan");
			expect(served).toEqual(["lead:503", f.side.id]);
			expect(errors.some((e) => e.includes("Lead 的决策与验收临时由 Sidekick 代理"))).toBe(true);
			expect((created.session.messages.at(-1) as any).stopReason).toBe("stop");
		} finally { created?.workflow.dispose(); created?.session.dispose(); await rm(f.cwd, { recursive: true, force: true }); }
	}, 30000);

	test("failover=false keeps the previous single-model behaviour", async () => {
		const f = await fixture("fusion-ha-off-", false);
		let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			const served: string[] = [];
			f.runtime.streamSimple = (model) => { served.push(model.id); return failure(model, "401 invalid x-api-key"); };
			created = await createWorkflowSession({ cwd: f.cwd, agentDir: join(f.cwd, "agent"), debugRoot: f.cwd, modelRuntime: f.runtime,
				sessionManager: SessionManager.inMemory(f.cwd), initialMode: "agent", getPermission: () => "auto", initialFusion: f.initialFusion,
				onChange: () => undefined, onModeChange: () => undefined, onError: () => undefined });
			await created.session.prompt("hi");
			expect(served).toEqual([f.lead.id]);
		} finally { created?.workflow.dispose(); created?.session.dispose(); await rm(f.cwd, { recursive: true, force: true }); }
	}, 30000);
});
