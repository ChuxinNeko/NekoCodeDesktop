/**
 * What a model call would cost at API prices, from LiteLLM's price list.
 *
 * Subscriptions report no money — ChatGPT, Copilot, Antigravity and the rest
 * are paid for by the month — and a custom endpoint reports whatever its
 * server does, usually nothing. So the Token page's cost figure was zero for
 * most people. LiteLLM keeps the price list most cost trackers use
 * (`model_prices_and_context_window.json`): per model and per platform, with
 * input, output, cache-read and cache-write rates. This pulls it once a day,
 * keeps a trimmed copy on disk so the figure survives being offline, and
 * prices each call that reported no cost of its own.
 *
 * The result is an estimate — the API-equivalent value of what was used — and
 * the page says so. Two known simplifications: long-context price tiers are
 * not applied (usage is summed per day, and a tier depends on one call's
 * prompt size), and a model sold on many platforms is priced at its maker's
 * list price rather than whatever a particular endpoint charges.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenCounts, TokenPricingStatus } from "../shared/tokenStats";

/**
 * The same file twice: GitHub first, then jsDelivr's mirror of it for
 * networks where raw.githubusercontent.com does not load.
 */
export const LITELLM_PRICE_URLS = [
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
	"https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
] as const;
const FILE = "litellm-prices.json";
/** Where earlier versions kept models.dev prices; removed once LiteLLM's are in. */
const LEGACY_FILE = "models-dev-prices.json";
/** How old the prices may get before they are pulled again. */
export const PRICING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How often to check whether they have got that old. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** After a failed pull, when to try again. */
const RETRY_AFTER_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;

/** USD per million tokens. */
export interface ModelPrice {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** A price, and where it came from — `platform/model` in LiteLLM's list. */
export interface ResolvedPrice extends ModelPrice {
	source: string;
}

/** What is kept of the list: platform → model key → price. Everything else is dropped. */
export type PriceTable = Record<string, Record<string, ModelPrice>>;

export interface PricingSnapshot {
	fetchedAt: number;
	providers: PriceTable;
}

export type PricingStatus = TokenPricingStatus;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A per-token rate as a per-million one, rounded clear of float noise (3e-7 → 0.3). */
function perMillion(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.round(value * 1e12) / 1e6;
}

/** The entry kinds that are text calls; images, embeddings and audio are priced otherwise. */
const TEXT_MODES = new Set(["chat", "responses", "completion"]);

/**
 * Only text models with an input and output price, and only their four rates.
 * `sample_spec` — the list's own documentation entry — has no platform and
 * falls out on its own.
 */
export function trimLiteLLM(list: unknown): PriceTable {
	const table: PriceTable = {};
	for (const [key, value] of Object.entries(record(list) ?? {})) {
		const entry = record(value);
		const platform = entry?.litellm_provider;
		if (typeof platform !== "string" || !platform) continue;
		if (typeof entry?.mode === "string" && !TEXT_MODES.has(entry.mode)) continue;
		const input = perMillion(entry?.input_cost_per_token);
		const output = perMillion(entry?.output_cost_per_token);
		if (input === undefined || output === undefined) continue;
		const cacheRead = perMillion(entry?.cache_read_input_token_cost);
		const cacheWrite = perMillion(entry?.cache_creation_input_token_cost);
		(table[platform] ??= {})[key] = {
			input,
			output,
			...(cacheRead !== undefined ? { cacheRead } : {}),
			...(cacheWrite !== undefined ? { cacheWrite } : {}),
		};
	}
	return table;
}

// --- matching a call to a price ---------------------------------------------------

/**
 * One spelling for the ways a model id is written: the platform prefix a key
 * carries (`gemini/…`, `openrouter/deepseek/…`), a variant after a colon
 * (`:free`), a snapshot date, and dots versus dashes (`claude-sonnet-4.5` /
 * `claude-sonnet-4-5`).
 */
export function normalizeModelId(id: string): string {
	return id
		.toLowerCase()
		.trim()
		.split("/")
		.pop()!
		.split(":")[0]
		.replace(/-(20\d{6}|\d{4}-\d{2}-\d{2})$/, "")
		.replace(/\./g, "-");
}

/**
 * Suffixes a client adds to pick a reasoning effort — Antigravity's
 * `gemini-3-flash-high`, `claude-opus-4-6-thinking` — that no price list has.
 * Only tried once the full id has found nothing.
 */
const VARIANT_SUFFIX = /-(thinking|high|medium|low|minimal|xhigh)$/;

/** Who makes a model family, by LiteLLM's platform names: their own list price is the one to use. */
const MAKERS: ReadonlyArray<[RegExp, readonly string[]]> = [
	[/^claude/, ["anthropic"]],
	[/^(gpt|o\d|codex|chatgpt)/, ["openai"]],
	[/^(gemini|gemma)/, ["gemini", "vertex_ai-language-models"]],
	[/^grok/, ["xai"]],
	[/^deepseek/, ["deepseek"]],
	[/^kimi/, ["moonshot"]],
	[/^glm/, ["zai"]],
	[/^(qwen|qwq)/, ["dashscope"]],
	[/^(mistral|codestral|devstral|magistral|ministral|pixtral)/, ["mistral"]],
	[/^minimax/, ["minimax"]],
	[/^llama/, ["meta_llama"]],
];

/** pi's provider ids whose LiteLLM platform has another name. */
const PROVIDER_ALIASES: Record<string, string> = {
	"openai-codex": "openai",
	google: "gemini",
	"google-vertex": "vertex_ai-language-models",
	"kimi-coding": "moonshot",
	moonshotai: "moonshot",
	alibaba: "dashscope",
	"amazon-bedrock": "bedrock_converse",
	"azure-openai-responses": "azure",
	fireworks: "fireworks_ai",
	together: "together_ai",
	"vercel-ai-gateway": "vercel_ai_gateway",
};

export class PriceIndex {
	/** Normalized model id → every listing of it, in list order. */
	private readonly byModel = new Map<string, Array<{ provider: string; model: string; price: ModelPrice }>>();

	constructor(readonly table: PriceTable) {
		for (const [provider, models] of Object.entries(table)) {
			for (const [model, entry] of Object.entries(models)) {
				// A zero price is a subscription or a free tier, not what the call is worth.
				if (entry.input === 0 && entry.output === 0) continue;
				const key = normalizeModelId(model);
				const list = this.byModel.get(key) ?? [];
				list.push({ provider, model, price: entry });
				this.byModel.set(key, list);
			}
		}
	}

	get size(): number {
		return this.byModel.size;
	}

	/** The price for a call recorded under `provider` and `model`, if any is known. */
	lookup(provider: string, model: string): ResolvedPrice | undefined {
		let key = normalizeModelId(model);
		for (;;) {
			const found = this.pick(provider, key);
			if (found) return found;
			const shorter = key.replace(VARIANT_SUFFIX, "");
			if (shorter === key) return undefined;
			key = shorter;
		}
	}

	private pick(provider: string, key: string): ResolvedPrice | undefined {
		const listings = this.byModel.get(key);
		if (!listings?.length) return undefined;
		const preferred = [
			provider,
			PROVIDER_ALIASES[provider],
			...(MAKERS.find(([pattern]) => pattern.test(key))?.[1] ?? []),
			"openrouter",
		].filter((entry): entry is string => !!entry);
		for (const name of preferred) {
			const hit = listings.find((listing) => listing.provider === name);
			if (hit) return { ...hit.price, source: `${hit.provider}/${hit.model.split("/").pop()}` };
		}
		// Sold on many platforms, made by no one listed: the price most of them ask.
		const counts = new Map<string, { count: number; listing: (typeof listings)[number] }>();
		for (const listing of listings) {
			const id = `${listing.price.input}/${listing.price.output}`;
			const entry = counts.get(id);
			if (entry) entry.count++;
			else counts.set(id, { count: 1, listing });
		}
		const common = [...counts.values()].sort(
			(a, b) => b.count - a.count || a.listing.price.input - b.listing.price.input,
		)[0].listing;
		return { ...common.price, source: `${common.provider}/${common.model.split("/").pop()}` };
	}
}

/**
 * USD for these tokens at this price. Cache traffic without its own price is
 * charged as input, which is what a provider without a cache discount does.
 * Reasoning is already inside `output`.
 */
export function estimateCost(counts: Pick<TokenCounts, "input" | "output" | "cacheRead" | "cacheWrite">, entry: ModelPrice): number {
	return (
		(counts.input * entry.input +
			counts.output * entry.output +
			counts.cacheRead * (entry.cacheRead ?? entry.input) +
			counts.cacheWrite * (entry.cacheWrite ?? entry.input)) /
		1_000_000
	);
}

/**
 * Put a price on counts that reported none. Counts the provider priced keep
 * theirs; ones no price is known for are marked, so the page can say how much
 * it could not price rather than implying it was free.
 */
export function priceCounts<T extends TokenCounts>(counts: T, provider: string, model: string, index: PriceIndex | null): T {
	if (counts.costUsd > 0) return counts;
	const entry = index?.lookup(provider, model);
	if (!entry) return { ...counts, unpricedCalls: counts.unpricedCalls + counts.calls };
	const estimate = estimateCost(counts, entry);
	return { ...counts, costUsd: estimate, estimatedCostUsd: counts.estimatedCostUsd + estimate };
}

// --- keeping the prices current -----------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ModelPricingOptions {
	userDataDir: string;
	/** The global fetch goes through the app's proxy. */
	fetch?: FetchLike;
	now?: () => number;
}

/**
 * The copy of LiteLLM's prices in use: read from disk at once, pulled again
 * when a day old, checked hourly. A failed pull keeps the older copy.
 */
export class ModelPricingService {
	private snapshot: PricingSnapshot | null = null;
	private index: PriceIndex | null = null;
	private error: string | undefined;
	private pulling: Promise<void> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private retryAt = 0;
	private readonly path: string;

	constructor(private readonly options: ModelPricingOptions) {
		this.path = join(options.userDataDir, FILE);
		this.load();
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const parsed = record(JSON.parse(readFileSync(this.path, "utf8")));
			const fetchedAt = parsed?.fetchedAt;
			const providers = record(parsed?.providers);
			if (typeof fetchedAt !== "number" || !providers) return;
			this.use({ fetchedAt, providers: providers as PriceTable });
		} catch {
			// A damaged copy is replaced by the next pull.
		}
	}

	private use(snapshot: PricingSnapshot): void {
		this.snapshot = snapshot;
		this.index = new PriceIndex(snapshot.providers);
	}

	/** The index to price with, or null before any prices are known. */
	prices(): PriceIndex | null {
		return this.index;
	}

	status(): PricingStatus {
		return {
			fetchedAt: this.snapshot?.fetchedAt ?? null,
			models: this.index?.size ?? 0,
			...(this.error ? { error: this.error } : {}),
		};
	}

	/** Pull now if the copy is stale (or `force`); one pull at a time. */
	refresh(force = false): Promise<void> {
		if (this.pulling) return this.pulling;
		const now = this.now();
		const stale = !this.snapshot || now - this.snapshot.fetchedAt >= PRICING_MAX_AGE_MS;
		if (!force && (!stale || now < this.retryAt)) return Promise.resolve();
		this.pulling = this.pull().finally(() => {
			this.pulling = null;
		});
		return this.pulling;
	}

	/** The list from the first address that serves it. */
	private async download(): Promise<PriceTable> {
		const failures: string[] = [];
		for (const url of LITELLM_PRICE_URLS) {
			try {
				const response = await (this.options.fetch ?? globalThis.fetch)(url, {
					headers: { Accept: "application/json" },
					signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const table = trimLiteLLM(await response.json());
				if (!Object.keys(table).length) throw new Error("没有任何价格");
				return table;
			} catch (error) {
				failures.push(`${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(`无法获取 LiteLLM 价格表（${failures.join("；")}）`);
	}

	private async pull(): Promise<void> {
		try {
			const providers = await this.download();
			const snapshot = { fetchedAt: this.now(), providers };
			this.use(snapshot);
			this.error = undefined;
			this.retryAt = 0;
			this.persist(snapshot);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			this.retryAt = this.now() + RETRY_AFTER_MS;
		}
	}

	private persist(snapshot: PricingSnapshot): void {
		try {
			mkdirSync(this.options.userDataDir, { recursive: true });
			const temporary = `${this.path}.tmp`;
			writeFileSync(temporary, JSON.stringify(snapshot), "utf8");
			renameSync(temporary, this.path);
			rmSync(join(this.options.userDataDir, LEGACY_FILE), { force: true });
		} catch {
			// The prices still apply this run; only the offline copy is missing.
		}
	}

	/** Check at once, then hourly, for as long as the app runs. */
	start(): void {
		if (this.timer) return;
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), CHECK_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
