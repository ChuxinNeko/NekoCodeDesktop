import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Automation } from "../../shared/automation";
import { AutomationRunner } from "./runner";

/**
 * Drives the automation execution path against a local OpenAI-compatible mock, so
 * the test needs no credentials and no network beyond loopback. It asserts the two
 * things the panel depends on: the run's summary is the last assistant message, and
 * aborted runs report themselves as aborted.
 */

function sseResponse(content: string): Response {
	const created = Math.floor(Date.now() / 1000);
	const frames = [
		{
			id: "chatcmpl-mock",
			object: "chat.completion.chunk",
			created,
			model: "mock-model",
			choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
		},
		{
			id: "chatcmpl-mock",
			object: "chat.completion.chunk",
			created,
			model: "mock-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
	];
	return new Response(`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

async function makeRuntime(reply: string, delayMs = 0) {
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = await request.text();
			if (!url.pathname.endsWith("/chat/completions")) {
				return new Response("not found", { status: 404 });
			}
			if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
			const parsed = JSON.parse(body || "{}") as { stream?: boolean };
			if (parsed.stream) return sseResponse(reply);
			return Response.json({
				id: "chatcmpl-mock",
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: "mock-model",
				choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});

	const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
	runtime.registerProvider("nekocode-automation-test", {
		name: "Mock",
		baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
		apiKey: "mock-key",
		api: "openai-completions",
		authHeader: true,
		models: [
			{
				id: "mock-model",
				name: "mock-model",
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
	});
	return { runtime, stop: () => server.stop(true) };
}

function automation(overrides: Partial<Automation> = {}): Automation {
	return {
		id: "auto-1",
		name: "Test automation",
		cwd: tmpdir(),
		prompt: "Say hello.",
		modelKey: "nekocode-automation-test/mock-model",
		mode: "read-only",
		schedule: { kind: "interval", minutes: 60 },
		enabled: true,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

describe("AutomationRunner", () => {
	test("runs the prompt and reports the last assistant message as the summary", async () => {
		const { runtime, stop } = await makeRuntime("AUTOMATION_REPLY_OK");
		const sessionsDir = mkdtempSync(join(tmpdir(), "nekocode-automation-runs-"));
		try {
			const runner = new AutomationRunner({
				sessionsDir,
				getModelRuntime: () => Promise.resolve(runtime),
			});
			const outcome = await runner.run(automation(), new AbortController().signal);
			expect(outcome.summary).toContain("AUTOMATION_REPLY_OK");
			expect(outcome.aborted).toBe(false);
			expect(outcome.sessionFile).toBeDefined();
		} finally {
			stop();
			rmSync(sessionsDir, { recursive: true, force: true });
		}
	}, 30_000);

	test("an already-aborted signal reports the run as aborted", async () => {
		const { runtime, stop } = await makeRuntime("SHOULD_NOT_COMPLETE", 5_000);
		const sessionsDir = mkdtempSync(join(tmpdir(), "nekocode-automation-runs-"));
		try {
			const runner = new AutomationRunner({
				sessionsDir,
				getModelRuntime: () => Promise.resolve(runtime),
			});
			const controller = new AbortController();
			const pending = runner.run(automation(), controller.signal);
			controller.abort();
			const outcome = await pending;
			expect(outcome.aborted).toBe(true);
		} finally {
			stop();
			rmSync(sessionsDir, { recursive: true, force: true });
		}
	}, 30_000);
});
