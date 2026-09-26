import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_COUNTS } from "../shared/tokenStats";
import {
	estimateCost,
	LITELLM_PRICE_URLS,
	ModelPricingService,
	normalizeModelId,
	PRICING_MAX_AGE_MS,
	PriceIndex,
	priceCounts,
	trimLiteLLM,
} from "./model-pricing";
import { TokenStatsService } from "./token-stats";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "model-pricing-"));
	dirs.push(dir);
	return dir;
};

type Entry = Record<string, unknown>;
const chat = (platform: string, input: number, output: number, extra: Entry = {}): Entry => ({
	litellm_provider: platform,
	mode: "chat",
	input_cost_per_token: input / 1e6,
	output_cost_per_token: output / 1e6,
	...extra,
});

/**
 * A slice of LiteLLM's list in its own shape: per-token rates, platform
 * prefixes on some keys, makers and resellers, a subscription, and entries
 * that are not text calls.
 */
const LITELLM: Record<string, Entry> = {
	sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0, mode: "one of: chat, embedding" },
	"claude-sonnet-4-5": chat("anthropic", 3, 15, { cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6 }),
	"claude-opus-4-6": chat("anthropic", 5, 25, { cache_read_input_token_cost: 5e-7 }),
	// Resells Claude at a markup: never chosen over the maker.
	"poe/claude-sonnet-4-5": chat("poe", 9, 45),
	"gemini/gemini-3-flash": chat("gemini", 0.5, 3, { cache_read_input_token_cost: 5e-8, input_cost_per_token_above_200k_tokens: 1e-6 }),
	"gpt-5.5": chat("openai", 5, 30, { cache_read_input_token_cost: 5e-7 }),
	"deepseek/deepseek-flash": chat("deepseek", 0.3, 1.2, { cache_read_input_token_cost: 6e-9, cache_creation_input_token_cost: 0 }),
	// A subscription listing at zero: not what a call is worth.
	"github_copilot/qwen4-coder": chat("github_copilot", 0, 0),
	// Three platforms selling a model its maker does not list; two agree.
	"deepinfra/Qwen/Qwen4-Coder": chat("deepinfra", 0.2, 0.8),
	"nebius/Qwen/Qwen4-Coder": chat("nebius", 0.3, 1),
	"together_ai/Qwen/Qwen4-Coder": chat("together_ai", 0.2, 0.8),
	"openrouter/deepseek/deepseek-v5": chat("openrouter", 0.3, 1.2),
	// Not text calls, whatever their per-token rates.
	"text-embedding-9": { litellm_provider: "openai", mode: "embedding", input_cost_per_token: 1e-7, output_cost_per_token: 0 },
	"gpt-image-9": { litellm_provider: "openai", mode: "image_generation", input_cost_per_token: 5e-6, output_cost_per_token: 4e-5 },
	"no-platform": { mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
};

describe("reading LiteLLM's list", () => {
	test("text models only, their four rates per million, keyed by platform", () => {
		const table = trimLiteLLM(LITELLM);
		expect(table.anthropic["claude-sonnet-4-5"]).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		// Per-token 6e-9 is exactly 0.006 per million, not 0.006000000000000001.
		expect(table.deepseek["deepseek/deepseek-flash"]).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
		expect(table.gemini["gemini/gemini-3-flash"]).toEqual({ input: 0.5, output: 3, cacheRead: 0.05 });
		expect(Object.keys(table.openai)).toEqual(["gpt-5.5"]);
		expect(JSON.stringify(table)).not.toContain("sample_spec");
		expect(JSON.stringify(table)).not.toContain("no-platform");
		expect(trimLiteLLM(null)).toEqual({});
	});

	test("model ids are compared the way people write them", () => {
		expect(normalizeModelId("anthropic/Claude-Sonnet-4.5")).toBe("claude-sonnet-4-5");
		expect(normalizeModelId("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
		expect(normalizeModelId("openrouter/qwen/qwen4-coder:free")).toBe("qwen4-coder");
	});
});

describe("choosing a price", () => {
	const index = new PriceIndex(trimLiteLLM(LITELLM));

	test("the maker's own list price, whoever the call went through", () => {
		expect(index.lookup("github-copilot", "claude-sonnet-4.5")?.source).toBe("anthropic/claude-sonnet-4-5");
		expect(index.lookup("nekocode-1234", "claude-sonnet-4-5")?.input).toBe(3);
		expect(index.lookup("openai-codex", "gpt-5.5")?.source).toBe("openai/gpt-5.5");
		expect(index.lookup("nekocode-1234", "deepseek-flash")).toMatchObject({ source: "deepseek/deepseek-flash", cacheRead: 0.006 });
	});

	test("a reasoning-effort suffix falls back to the model itself", () => {
		expect(index.lookup("antigravity", "gemini-3-flash-high")?.source).toBe("gemini/gemini-3-flash");
		expect(index.lookup("antigravity", "claude-opus-4-6-thinking")?.source).toBe("anthropic/claude-opus-4-6");
	});

	test("without the maker: OpenRouter, else the price most platforms ask; zero prices never count", () => {
		expect(index.lookup("nekocode-x", "deepseek-v5")?.source).toBe("openrouter/deepseek-v5");
		expect(index.lookup("nekocode-x", "qwen4-coder")).toMatchObject({ input: 0.2, output: 0.8 });
	});

	test("an unknown model, or one that is not a text model, has no price", () => {
		expect(index.lookup("nekocode-x", "my-finetune")).toBeUndefined();
		expect(index.lookup("openai", "text-embedding-9")).toBeUndefined();
	});
});

describe("pricing counts", () => {
	const index = new PriceIndex(trimLiteLLM(LITELLM));
	const counts = { ...EMPTY_COUNTS, calls: 2, input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 10_000 };

	test("every kind of token at its own rate; cache without a price is charged as input", () => {
		expect(estimateCost(counts, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })).toBeCloseTo(3 + 1.5 + 0.6 + 0.0375, 9);
		expect(estimateCost(counts, { input: 1, output: 2 })).toBeCloseTo(1 + 0.2 + 2 + 0.01, 9);
	});

	test("a reported cost stands; an unreported one is estimated and marked; an unknown model is counted", () => {
		expect(priceCounts({ ...counts, costUsd: 7 }, "anthropic", "claude-sonnet-4-5", index)).toMatchObject({ costUsd: 7, estimatedCostUsd: 0 });
		const estimated = priceCounts(counts, "github-copilot", "claude-sonnet-4-5", index);
		expect(estimated.costUsd).toBeCloseTo(5.1375, 9);
		expect(estimated.estimatedCostUsd).toBe(estimated.costUsd);
		expect(priceCounts(counts, "nekocode-x", "my-finetune", index)).toMatchObject({ costUsd: 0, unpricedCalls: 2 });
		expect(priceCounts(counts, "x", "claude-sonnet-4-5", null)).toMatchObject({ costUsd: 0, unpricedCalls: 2 });
	});
});

describe("keeping prices current", () => {
	const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

	test("pulls, uses and saves a trimmed copy; a fresh copy is not pulled again", async () => {
		const dir = tempDir();
		let pulls = 0;
		let now = 1_000;
		const service = new ModelPricingService({ userDataDir: dir, now: () => now, fetch: async () => (pulls++, ok(LITELLM)) });
		expect(service.prices()).toBeNull();
		await service.refresh();
		expect(service.status()).toMatchObject({ fetchedAt: 1_000 });
		expect(service.prices()?.lookup("anthropic", "claude-sonnet-4-5")?.input).toBe(3);
		const saved = JSON.parse(readFileSync(join(dir, "litellm-prices.json"), "utf8"));
		expect(saved.providers.anthropic["claude-sonnet-4-5"]).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		await service.refresh();
		expect(pulls).toBe(1);
		now += PRICING_MAX_AGE_MS;
		await service.refresh();
		expect(pulls).toBe(2);
	});

	test("GitHub unreachable: the jsDelivr mirror is used", async () => {
		const asked: string[] = [];
		const service = new ModelPricingService({
			userDataDir: tempDir(),
			fetch: async (url) => {
				asked.push(url);
				if (url.includes("githubusercontent")) throw new Error("connect ETIMEDOUT");
				return ok(LITELLM);
			},
		});
		await service.refresh();
		expect(asked).toEqual([...LITELLM_PRICE_URLS]);
		expect(service.status().error).toBeUndefined();
		expect(service.prices()?.lookup("openai", "gpt-5.5")?.output).toBe(30);
	});

	test("the old models.dev copy is removed once LiteLLM's prices are saved", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "models-dev-prices.json"), "{}");
		await new ModelPricingService({ userDataDir: dir, fetch: async () => ok(LITELLM) }).refresh();
		expect(existsSync(join(dir, "models-dev-prices.json"))).toBe(false);
	});

	test("a saved copy is used offline, and a failed pull keeps it", async () => {
		const dir = tempDir();
		const first = new ModelPricingService({ userDataDir: dir, now: () => 1_000, fetch: async () => ok(LITELLM) });
		await first.refresh();
		const offline = new ModelPricingService({
			userDataDir: dir,
			now: () => 1_000 + PRICING_MAX_AGE_MS + 1,
			fetch: async () => {
				throw new Error("offline");
			},
		});
		expect(offline.prices()?.lookup("openai", "gpt-5.5")?.output).toBe(30);
		await offline.refresh();
		expect(offline.status().fetchedAt).toBe(1_000);
		expect(offline.status().error).toContain("offline");
		expect(offline.prices()).not.toBeNull();
	});

	test("an error page or an empty list is not taken for prices, from either address", async () => {
		const dir = tempDir();
		const service = new ModelPricingService({ userDataDir: dir, fetch: async () => new Response("down", { status: 503 }) });
		await service.refresh();
		expect(service.status().fetchedAt).toBeNull();
		expect(service.status().error).toContain("raw.githubusercontent.com: HTTP 503");
		expect(service.status().error).toContain("cdn.jsdelivr.net: HTTP 503");
		expect(existsSync(join(dir, "litellm-prices.json"))).toBe(false);
		const empty = new ModelPricingService({ userDataDir: tempDir(), fetch: async () => ok({ sample_spec: {} }) });
		await empty.refresh(true);
		expect(empty.status().error).toContain("没有任何价格");
	});
});

test("the token report prices each model's calls, and sessions add up to the same", async () => {
	const dir = tempDir();
	const sessions = join(dir, "sessions");
	mkdirSync(sessions);
	const at = "2026-09-20T10:00:00.000Z";
	const call = (provider: string, model: string, input: number, output: number, cost?: number) =>
		JSON.stringify({
			type: "message",
			timestamp: at,
			message: {
				role: "assistant",
				provider,
				model,
				timestamp: Date.parse(at),
				usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, ...(cost ? { cost: { total: cost } } : {}) },
			},
		});
	writeFileSync(
		join(sessions, "a.jsonl"),
		[
			JSON.stringify({ type: "session", id: "a", cwd: "/p", timestamp: at }),
			call("github-copilot", "claude-sonnet-4.5", 1_000_000, 0),
			call("anthropic", "claude-sonnet-4-5", 1_000_000, 0, 2.5),
			call("nekocode-x", "my-finetune", 500, 0),
		].join("\n") + "\n",
	);
	const pricing = new ModelPricingService({ userDataDir: dir, fetch: async () => new Response(JSON.stringify(LITELLM)) });
	await pricing.refresh();
	const stats = new TokenStatsService({ sessionDir: sessions, prices: () => pricing.prices(), pricingStatus: () => pricing.status() });
	const report = await stats.report();
	const copilot = report.buckets.find((bucket) => bucket.provider === "github-copilot")!;
	expect(copilot).toMatchObject({ costUsd: 3, estimatedCostUsd: 3 });
	expect(report.buckets.find((bucket) => bucket.provider === "anthropic")).toMatchObject({ costUsd: 2.5, estimatedCostUsd: 0 });
	expect(report.buckets.find((bucket) => bucket.provider === "nekocode-x")).toMatchObject({ costUsd: 0, unpricedCalls: 1 });
	expect(report.sessions[0]).toMatchObject({ costUsd: 5.5, estimatedCostUsd: 3, unpricedCalls: 1, calls: 3 });
	expect(report.pricing.models).toBeGreaterThan(0);
});
