import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel } from "../shared/agent";
import type { FusionModelRole } from "./fusion-routing";

/** No byte from the provider within this window counts as an unavailable endpoint. */
export const FUSION_FIRST_EVENT_TIMEOUT_MS = 120_000;
/** A stream that stops emitting for this long is stalled, even if it started. */
export const FUSION_STREAM_IDLE_TIMEOUT_MS = 180_000;
/** Circuit breaker cooldown after the first failure; doubles per consecutive failure. */
export const FUSION_CIRCUIT_BASE_COOLDOWN_MS = 30_000;
export const FUSION_CIRCUIT_MAX_COOLDOWN_MS = 300_000;

export interface FusionFailoverRoute {
	role: FusionModelRole;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
}

export interface FusionFailoverEvent {
	type: "failover" | "exhausted" | "recovered";
	from: string;
	to?: string;
	fromRole: FusionModelRole;
	toRole?: FusionModelRole;
	error?: string;
}

interface Circuit { failures: number; openUntil: number; lastError: string }

/**
 * Per-model circuit breaker shared by the main conversation and helpers.
 * A failed model is tried last until its cooldown expires (half-open), then
 * gets one probe; success closes the circuit immediately.
 */
export class FusionModelHealth {
	private circuits = new Map<string, Circuit>();
	constructor(private readonly now: () => number = Date.now,
		private readonly baseCooldownMs = FUSION_CIRCUIT_BASE_COOLDOWN_MS,
		private readonly maxCooldownMs = FUSION_CIRCUIT_MAX_COOLDOWN_MS) {}
	available(key: string): boolean {
		const circuit = this.circuits.get(key);
		return !circuit || circuit.openUntil <= this.now();
	}
	/** Opens (or re-opens with a longer cooldown) the model's circuit. */
	failure(key: string, error: string): void {
		const failures = (this.circuits.get(key)?.failures ?? 0) + 1;
		const cooldown = Math.min(this.maxCooldownMs, this.baseCooldownMs * 2 ** (failures - 1));
		this.circuits.set(key, { failures, openUntil: this.now() + cooldown, lastError: error.slice(0, 500) });
	}
	/** True when a previously failing model recovered. */
	success(key: string): boolean { return this.circuits.delete(key); }
	order<T extends { model: Model<Api> }>(routes: T[]): T[] {
		const healthy = routes.filter((route) => this.available(keyOf(route.model)));
		const open = routes.filter((route) => !this.available(keyOf(route.model)));
		// Never return zero candidates: an all-open set still probes in preference order.
		return [...healthy, ...open];
	}
	snapshot() {
		return [...this.circuits].map(([model, circuit]) => ({ model, failures: circuit.failures,
			open: circuit.openUntil > this.now(), retryInMs: Math.max(0, circuit.openUntil - this.now()), lastError: circuit.lastError }));
	}
	reset(): void { this.circuits.clear(); }
}

export const keyOf = (model: Pick<Model<Api>, "provider" | "id">) => `${model.provider}/${model.id}`;

export interface FusionFailoverOptions {
	/** Ordered candidates for the requested model; first is the role's own model. Empty disables failover. */
	routes: (model: Model<Api>) => FusionFailoverRoute[];
	health: FusionModelHealth;
	createStream: () => AssistantMessageEventStream;
	isContextOverflow: (message: AssistantMessage, contextWindow?: number) => boolean;
	onEvent?: (event: FusionFailoverEvent) => void;
	firstEventMs?: number;
	idleMs?: number;
}

function failedMessage(model: Model<Api>, error: string): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error", errorMessage: error, timestamp: Date.now() } as AssistantMessage;
}

/**
 * Transparent in-request failover between the two Fusion models.
 *
 * Events are forwarded only after the provider produces real content; a failure
 * before that point (auth, quota, 4xx/5xx, network, stall) is invisible to the
 * agent loop and the same request is replayed on the other model with that
 * model's own thinking level and credentials. Once content has streamed, a
 * failure is surfaced unchanged so PI's own retry/compaction policy applies.
 * User aborts and context overflow never fail over.
 */
export function withFusionFailover(base: StreamFn, options: FusionFailoverOptions): StreamFn {
	const firstEventMs = options.firstEventMs ?? FUSION_FIRST_EVENT_TIMEOUT_MS;
	const idleMs = options.idleMs ?? FUSION_STREAM_IDLE_TIMEOUT_MS;
	return (model, context, streamOptions) => {
		const declared = options.routes(model);
		if (!declared.length) return base(model, context, streamOptions);
		const candidates = options.health.order(declared);
		const out = options.createStream();
		const outer = streamOptions?.signal;
		void (async () => {
			for (let index = 0; index < candidates.length; index++) {
				const route = candidates[index];
				const key = keyOf(route.model);
				const attempt = new AbortController();
				const forward = () => attempt.abort(outer?.reason);
				if (outer?.aborted) attempt.abort(outer.reason); else outer?.addEventListener("abort", forward, { once: true });
				let stalled = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const arm = (ms: number) => {
					if (timer) clearTimeout(timer);
					timer = setTimeout(() => { stalled = true; attempt.abort(new Error("stalled")); }, ms);
					(timer as { unref?: () => void }).unref?.();
				};
				arm(firstEventMs);
				let committed = false;
				const pending: AssistantMessageEvent[] = [];
				let failure: AssistantMessage | undefined;
				let finished = false;
				try {
					// Credentials resolved for another provider must not leak to this vendor.
					const sameProvider = route.model.provider === model.provider;
					const { apiKey, headers, env, ...rest } = (streamOptions ?? {}) as NonNullable<typeof streamOptions> & { env?: unknown };
					const limit = route.model.maxTokens;
					const maxTokens = rest.maxTokens && limit > 0 ? Math.min(rest.maxTokens, limit) : rest.maxTokens;
					const requestOptions = index === 0 && keyOf(route.model) === keyOf(model) ? { ...streamOptions, signal: attempt.signal } : {
						...rest, ...(sameProvider ? { apiKey, headers, env } : {}), maxTokens, signal: attempt.signal,
						reasoning: route.thinkingLevel === "off" ? undefined : route.thinkingLevel,
					};
					const stream = await base(index === 0 && keyOf(route.model) === keyOf(model) ? model : route.model, context, requestOptions as typeof streamOptions);
					for await (const event of stream) {
						// An empty "start" is not output: keep the first-output window running.
						if (event.type !== "start") arm(idleMs);
						if (event.type === "error") { failure = event.error; break; }
						if (event.type === "done") {
							for (const item of pending.splice(0)) out.push(item);
							out.push(event);
							finished = true;
							break;
						}
						if (!committed && event.type === "start") { pending.push(event); continue; }
						if (!committed) { committed = true; for (const item of pending.splice(0)) out.push(item); }
						out.push(event);
					}
					// A transport that ends iteration without a terminal event is a failure too.
					if (!failure && !finished) failure = failedMessage(route.model, "Provider stream ended without a terminal event");
				} catch (error) {
					failure = failedMessage(route.model, error instanceof Error ? error.message : String(error));
				} finally {
					if (timer) clearTimeout(timer);
					outer?.removeEventListener("abort", forward);
				}
				if (!failure) {
					if (options.health.success(key)) options.onEvent?.({ type: "recovered", from: key, fromRole: route.role });
					return;
				}
				if (outer?.aborted) {
					for (const item of pending.splice(0)) out.push(item);
					out.push({ type: "error", reason: "aborted", error: { ...failure, stopReason: "aborted" } });
					return;
				}
				if (stalled) failure = { ...failure, stopReason: "error",
					errorMessage: `Provider stream timed out: ${key} produced no events for ${Math.round((committed ? idleMs : firstEventMs) / 1000)}s` };
				const message = failure.errorMessage || "Unknown provider error";
				const overflow = options.isContextOverflow(failure, route.model.contextWindow);
				if (!overflow) options.health.failure(key, message);
				const next = candidates[index + 1];
				if (committed || overflow || !next) {
					if (!overflow && !committed) options.onEvent?.({ type: "exhausted", from: key, fromRole: route.role, error: message });
					for (const item of pending.splice(0)) out.push(item);
					out.push({ type: "error", reason: "error", error: { ...failure, stopReason: "error", errorMessage: message } });
					return;
				}
				options.onEvent?.({ type: "failover", from: key, to: keyOf(next.model), fromRole: route.role, toRole: next.role, error: message });
			}
		})().catch((error) => {
			out.push({ type: "error", reason: "error", error: failedMessage(model, String(error)) });
		});
		return out;
	};
}
