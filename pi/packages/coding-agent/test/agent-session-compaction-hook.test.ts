import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession, type AfterCompactionContext } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

async function setup(hook: (context: AfterCompactionContext) => Promise<void>) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-compact-hook-"));
	const auth = AuthStorage.create(join(cwd, "auth.json"));
	await auth.modify("anthropic", async () => ({ type: "api_key", key: "test-only" }));
	const runtime = getModelRuntime(await createModelRegistry(auth, cwd));
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const manager = SessionManager.inMemory(cwd);
	manager.appendMessage({ role: "user", content: "old conversation", timestamp: 1 });
	manager.appendMessage({ ...fauxAssistantMessage("old answer"), api: model.api, provider: model.provider, model: model.id,
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const settings = SettingsManager.create(cwd, cwd);
	settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const agent = new Agent({ initialState: { model, messages: manager.buildSessionContext().messages, tools: [], systemPrompt: "Test" },
		streamFn: (selected) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: {
				...fauxAssistantMessage("summary"), api: selected.api, provider: selected.provider, model: selected.id,
			} }));
			return stream;
		} });
	const session = new AgentSession({ agent, sessionManager: manager, settingsManager: settings, cwd,
		modelRuntime: runtime, resourceLoader: createTestResourceLoader(), afterCompaction: hook });
	return { session, manager, async cleanup() { session.dispose(); await rm(cwd, { recursive: true, force: true }); } };
}

describe("awaited SDK compaction boundary", () => {
	it.each(["manual", "threshold", "overflow"] as const)("awaits the hook before %s completion/retry", async (reason) => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let projectionWasUpdated = false;
		const fixture = await setup(async (context) => {
			expect(context.reason).toBe(reason);
			expect(context.willRetry).toBe(reason === "overflow");
			projectionWasUpdated = fixture.manager.getBranch().some((entry) => entry.type === "compaction") &&
				fixture.session.messages.some((message) => message.role === "compactionSummary");
			entered(); await gate;
		});
		try {
			let ended = false;
			fixture.session.subscribe((event) => { if (event.type === "compaction_end") ended = true; });
			const internal = fixture.session as unknown as { _runAutoCompaction: (reason: string, retry: boolean) => Promise<boolean> };
			const pending = reason === "manual" ? fixture.session.compact() : internal._runAutoCompaction(reason, reason === "overflow");
			await started;
			expect(projectionWasUpdated).toBe(true); expect(ended).toBe(false);
			release(); await pending; expect(ended).toBe(true);
		} finally { release?.(); await fixture.cleanup(); }
	});
	it("hook failure is separate from an already committed compaction", async () => {
		const fixture = await setup(async () => { throw new Error("route unavailable"); });
		try {
			const events: string[] = [];
			fixture.session.subscribe((event) => events.push(event.type));
			await expect(fixture.session.compact()).resolves.toHaveProperty("summary", expect.stringContaining("summary"));
			expect(events).toContain("compaction_hook_error");
			expect(events).toContain("compaction_end");
			expect(fixture.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		} finally { await fixture.cleanup(); }
	});
});
