import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream, fauxAssistantMessage, isContextOverflow, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { FusionModelHealth, withFusionFailover, type FusionFailoverEvent } from "../../src/main/fusion-failover";

const lead: Model<Api> = getModel("anthropic", "claude-opus-4-5")!;
const side: Model<Api> = getModel("openai", "gpt-5-mini")!;
const message = (model: typeof lead, text: string): AssistantMessage => ({ ...fauxAssistantMessage(text), provider: model.provider, model: model.id, api: model.api });
const fail = (model: typeof lead, error: string) => ({ ...message(model, ""), content: [], stopReason: "error" as const, errorMessage: error });

function setup(behaviour: (model: typeof lead, signal?: AbortSignal) => "ok" | "error" | "midstream" | "stall" | "throw" | "overflow", opts: { firstEventMs?: number; idleMs?: number; now?: () => number } = {}) {
	const calls: { model: string; apiKey?: string; reasoning?: string }[] = []; const events: FusionFailoverEvent[] = [];
	const health = new FusionModelHealth(opts.now);
	const base = (model: any, _context: any, options: any) => {
		calls.push({ model: model.id, apiKey: options?.apiKey, reasoning: options?.reasoning });
		const kind = behaviour(model, options?.signal);
		if (kind === "throw") throw new Error("401 invalid x-api-key");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const partial = message(model, "");
			if (kind === "stall") { stream.push({ type: "start", partial });
				options?.signal?.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted", error: { ...fail(model, "Request was aborted"), stopReason: "aborted" } }));
				return; }
			stream.push({ type: "start", partial });
			if (kind === "error") return stream.push({ type: "error", reason: "error", error: fail(model, "429 insufficient_quota") });
			if (kind === "overflow") return stream.push({ type: "error", reason: "error", error: fail(model, "prompt is too long: 300000 tokens > 200000 maximum") });
			stream.push({ type: "text_start", contentIndex: 0, partial });
			if (kind === "midstream") return stream.push({ type: "error", reason: "error", error: fail(model, "socket hang up") });
			stream.push({ type: "done", reason: "stop", message: message(model, "answer from " + model.id) });
		});
		return stream;
	};
	const routes = (model: any) => {
		const own = model.id === lead.id ? { role: "lead" as const, model, thinkingLevel: "high" as const } : { role: "sidekick" as const, model, thinkingLevel: "low" as const };
		const partner = model.id === lead.id ? { role: "sidekick" as const, model: side, thinkingLevel: "low" as const } : { role: "lead" as const, model: lead, thinkingLevel: "high" as const };
		return [own, partner];
	};
	const stream = withFusionFailover(base as any, { routes, health, createStream: createAssistantMessageEventStream, isContextOverflow,
		onEvent: (event) => events.push(event), firstEventMs: opts.firstEventMs ?? 1000, idleMs: opts.idleMs ?? 1000 });
	const run = async (model: typeof lead, signal?: AbortSignal) => {
		const out = await stream(model, { messages: [] } as any, { apiKey: "sk-" + model.provider, reasoning: model.id === lead.id ? "high" : "low", signal } as any);
		const seen: string[] = []; for await (const event of out) seen.push(event.type);
		return { result: await out.result(), seen };
	};
	return { calls, events, health, run };
}

describe("Fusion two-model failover", () => {
	test("Sidekick endpoint failure before output is replayed on Lead with Lead credentials and thinking", async () => {
		const f = setup((model) => model.id === side.id ? "error" : "ok");
		const { result, seen } = await f.run(side);
		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe(lead.id);
		expect(seen.filter((type) => type === "start")).toHaveLength(1);
		// The OpenAI key must never be sent to Anthropic; runtime resolves Lead's own key.
		expect(f.calls).toEqual([{ model: side.id, apiKey: "sk-openai", reasoning: "low" }, { model: lead.id, apiKey: undefined, reasoning: "high" }]);
		expect(f.events.map((e) => [e.type, e.fromRole, e.toRole])).toEqual([["failover", "sidekick", "lead"]]);
	});

	test("Lead outage degrades to Sidekick instead of stopping the run", async () => {
		const f = setup((model, _signal) => model.id === lead.id ? "throw" : "ok");
		const { result } = await f.run(lead);
		expect(result.model).toBe(side.id);
		expect(f.events[0]).toMatchObject({ type: "failover", fromRole: "lead", toRole: "sidekick" });
	});

	test("open circuit skips the failed model until cooldown, then probes and recovers", async () => {
		let now = 0; let sideDown = true;
		const f = setup((model) => model.id === side.id && sideDown ? "error" : "ok", { now: () => now });
		await f.run(side);
		await f.run(side);
		expect(f.calls.map((c) => c.model)).toEqual([side.id, lead.id, lead.id]);
		now = 31_000; sideDown = false;
		const { result } = await f.run(side);
		expect(result.model).toBe(side.id);
		expect(f.events.at(-1)?.type).toBe("recovered");
		expect(f.health.snapshot()).toEqual([]);
	});

	test("cooldown doubles on consecutive failures and is capped", () => {
		let now = 0; const health = new FusionModelHealth(() => now, 10, 25);
		health.failure("a/b", "x"); now = 9; expect(health.available("a/b")).toBe(false); now = 10; expect(health.available("a/b")).toBe(true);
		health.failure("a/b", "x"); now = 29; expect(health.available("a/b")).toBe(false); now = 30; expect(health.available("a/b")).toBe(true);
		health.failure("a/b", "x"); now = 54; expect(health.available("a/b")).toBe(false); now = 55; expect(health.available("a/b")).toBe(true);
	});

	test("a stalled stream is aborted by the watchdog and replayed", async () => {
		const f = setup((model) => model.id === side.id ? "stall" : "ok", { firstEventMs: 30 });
		const started = Date.now(); const { result } = await f.run(side);
		expect(result.model).toBe(lead.id);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(f.events[0].error).toContain("timed out");
	});

	test("both models down returns one retryable error, no infinite loop", async () => {
		const f = setup(() => "error");
		const { result } = await f.run(side);
		expect(result.stopReason).toBe("error");
		expect(f.calls).toHaveLength(2);
		expect(f.events.map((e) => e.type)).toEqual(["failover", "exhausted"]);
	});

	test("failure after streamed output is surfaced unchanged for PI retry", async () => {
		const f = setup((model) => model.id === side.id ? "midstream" : "ok");
		const { result, seen } = await f.run(side);
		expect(result.errorMessage).toBe("socket hang up");
		expect(seen).toContain("text_start");
		expect(f.calls).toHaveLength(1);
	});

	test("context overflow and user abort never fail over", async () => {
		const overflow = setup(() => "overflow");
		expect((await overflow.run(side)).result.stopReason).toBe("error");
		expect(overflow.calls).toHaveLength(1);
		expect(overflow.health.snapshot()).toEqual([]);
		const controller = new AbortController();
		const aborted = setup(() => "stall", { firstEventMs: 5000 });
		setTimeout(() => controller.abort(), 20);
		const { result } = await aborted.run(side, controller.signal);
		expect(result.stopReason).toBe("aborted");
		expect(aborted.calls).toHaveLength(1);
		expect(aborted.events).toEqual([]);
	});
});
