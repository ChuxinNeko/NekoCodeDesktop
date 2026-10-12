import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentCell, TurnUsage } from "../shared/agent";
import { isFusionConfig, type FusionConfig } from "../shared/fusion";
import { FUSION_ENTRY } from "./fusion-config";
import { aggregateTurnUsage, type ProjectableMessage } from "./agent-projection";

/** Custom entries stay out of the model context but survive session reopening. */
export const FUSION_USAGE_ENTRY = "nekocode.fusion-usage.v1";
export const FAST_CONTEXT_USAGE_ENTRY = "nekocode.fast-context-usage.v1";
export const FUSION_TASK_METRIC_ENTRY = "nekocode.fusion-task-metric.v1";

/** Per-worker observations for end-to-end evaluations; no prompt or tool output is stored. */
export interface FusionTaskMetric {
	taskId: string;
	parentEntryId?: string;
	kind: "worker" | "explore";
	status: "completed" | "failed" | "cancelled";
	outcome?: "completed" | "blocked" | "needs_decision" | "needs_escalation";
	startedAt: number;
	endedAt: number;
	verificationMode?: "run" | "skip";
	plannedChecks: number;
	observedCommands: number;
	failedCommands: number;
	acceptance?: { met: number; unverified: number; notMet: number };
}

export type FusionUsageKind = "inference" | "compaction" | "cache-warm";
export interface FusionUsageRecord {
	turnTimestamp: number;
	/** Optional for compatibility with v1 records written before detailed attribution. */
	taskId?: string;
	parentEntryId?: string;
	sourceEntryId?: string;
	kind?: FusionUsageKind;
	usage: TurnUsage;
}

function readRecord(data: unknown): FusionUsageRecord | undefined {
	if (!data || typeof data !== "object") return;
	const record = data as FusionUsageRecord;
	const usage = record.usage;
	if (!Number.isFinite(record.turnTimestamp) || !usage ||
		typeof usage.provider !== "string" || typeof usage.model !== "string") return;
	if (![usage.calls, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens]
		.every((value) => Number.isFinite(value) && value >= 0)) return;
	if (record.kind !== undefined && !["inference", "compaction", "cache-warm"].includes(record.kind)) return;
	if ([record.taskId, record.parentEntryId, record.sourceEntryId].some((value) => value !== undefined && typeof value !== "string")) return;
	return record;
}

/** Provider usage for maintenance calls which do not produce assistant messages. */
export function maintenanceUsage(provider: string, model: string, usage: {
	input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
	cost?: { total?: number };
}): TurnUsage {
	return { provider, model, calls: 1, input: usage.input, output: usage.output,
		cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens,
		...(Number.isFinite(usage.cost?.total) ? { costUsd: usage.cost!.total } : {}),
	};
}

function sumUsage(parts: TurnUsage[]): TurnUsage {
	const result: TurnUsage = {
		provider: parts.at(-1)!.provider, model: parts.at(-1)!.model,
		calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	};
	for (const part of parts) {
		for (const key of ["calls", "input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
			result[key] += part[key];
		for (const key of ["reasoning", "modelMs", "durationMs"] as const) {
			if (part[key] !== undefined) result[key] = (result[key] ?? 0) + part[key];
		}
		if (part.responseModel) result.responseModel = part.responseModel;
	}
	// A partial bill is not the total price of a Fusion turn.
	if (parts.every((part) => Number.isFinite(part.costUsd) && part.costUsd! >= 0))
		result.costUsd = parts.reduce((sum, part) => sum + part.costUsd!, 0);
	return result;
}

function fusionBreakdown(records: Array<FusionUsageRecord & { source?: "main" | "auxiliary" | "fast-context" }>): NonNullable<NonNullable<TurnUsage["fusion"]>["breakdown"]> {
	const groups = new Map<string, { taskId?: string; source?: "main" | "auxiliary" | "fast-context"; kind: FusionUsageKind; parts: TurnUsage[] }>();
	for (const record of records) {
		const kind = record.kind ?? "inference";
		const key = JSON.stringify([record.source, record.taskId, kind, record.usage.provider, record.usage.model, record.usage.responseModel]);
		let group = groups.get(key);
		if (!group) groups.set(key, group = { taskId: record.taskId, source: record.source, kind, parts: [] });
		group.parts.push(record.usage);
	}
	return [...groups.values()].map(({ taskId, source, kind, parts }) => ({ taskId, source, kind, usage: sumUsage(parts) }));
}

/** Join by the originating prompt, never by the current picker or finish time. */
export function withFusionUsage(
	cells: AgentCell[],
	entries: readonly SessionEntry[],
	helpersRunning = false,
): AgentCell[] {
	let config: FusionConfig | undefined;
	let latestTurn: number | undefined;
	const turns = new Map<
		number,
		{ config?: FusionConfig; fusionParts: TurnUsage[]; fastContextParts: TurnUsage[]; records: FusionUsageRecord[]; userEntryId: string; mainMessages: ProjectableMessage[] }
	>();
	const seenSources = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === FUSION_ENTRY) {
			config = isFusionConfig(entry.data) ? entry.data : undefined;
		} else if (entry.type === "message" && entry.message.role === "user") {
			latestTurn = entry.message.timestamp;
			turns.set(latestTurn, { config, fusionParts: [], fastContextParts: [], records: [], userEntryId: entry.id, mainMessages: [] });
		} else if (entry.type === "message" && entry.message.role === "assistant" && latestTurn !== undefined) {
			turns.get(latestTurn)?.mainMessages.push(entry.message);
		} else if (entry.type === "custom" && entry.customType === FUSION_USAGE_ENTRY) {
			const record = readRecord(entry.data);
			const turn = record && turns.get(record.turnTimestamp);
			if (record && turn?.config && (!record.parentEntryId || record.parentEntryId === turn.userEntryId)) {
				if (record.sourceEntryId && seenSources.has(record.sourceEntryId)) continue;
				if (record.sourceEntryId) seenSources.add(record.sourceEntryId);
				turn.fusionParts.push(record.usage);
				turn.records.push(record);
			}
		} else if (entry.type === "custom" && entry.customType === FAST_CONTEXT_USAGE_ENTRY) {
			const record = readRecord(entry.data);
			const turn = record && turns.get(record.turnTimestamp);
			if (record && turn && (!record.parentEntryId || record.parentEntryId === turn.userEntryId)) {
				if (record.sourceEntryId && seenSources.has(record.sourceEntryId)) continue;
				if (record.sourceEntryId) seenSources.add(record.sourceEntryId);
				turn.fastContextParts.push(record.usage);
			}
		}
	}
	let turnTimestamp: number | undefined;
	return cells.map((cell) => {
		if (cell.type === "user") turnTimestamp = cell.timestamp;
		if (cell.type !== "assistant" || !cell.usage || turnTimestamp === undefined) return cell;
		const turn = turns.get(turnTimestamp);
		if (!turn || (!turn.config && !turn.fastContextParts.length)) return cell;
		if (helpersRunning && turnTimestamp === latestTurn) return { ...cell, usage: undefined };
		const main = cell.usage;
		// Historical assistant messages still carry the model used for each call.
		const historical = aggregateTurnUsage(turn.mainMessages);
		const mainParts = main.modelBreakdown ?? (historical?.totalTokens === main.totalTokens && historical.calls === main.calls
			? historical.modelBreakdown : undefined) ?? [main.calls > 1 ? { ...main, provider: "", model: "unknown" } : main];
		const allParts = [...mainParts, ...turn.fusionParts, ...turn.fastContextParts];
		const roleParts = (key: string) => allParts.filter((part) => `${part.provider}/${part.model}` === key);
		const sameModel = turn.config?.leadModelKey === turn.config?.sidekickModelKey;
		const leadParts = turn.config && !sameModel ? roleParts(turn.config.leadModelKey) : [];
		const sideParts = turn.config && !sameModel ? roleParts(turn.config.sidekickModelKey) : [];
		const splitKey = (key: string) => ({ provider: key.slice(0, key.indexOf("/")), model: key.slice(key.indexOf("/") + 1) });
		const roleUsage = (parts: TurnUsage[]) => parts.length === 1 ? parts[0] : parts.length ? sumUsage(parts) : undefined;
		const lead = turn.config ? roleUsage(leadParts) ?? { ...splitKey(turn.config.leadModelKey), calls: 0,
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } : main;
		const sidekickUsage = roleUsage(sideParts);
		const otherParts = turn.config ? allParts.filter((part) => sameModel ||
			![turn.config!.leadModelKey, turn.config!.sidekickModelKey].includes(`${part.provider}/${part.model}`)) : [];
		const unattributed = otherParts.length ? sumUsage(otherParts) : undefined;
		const sidekick = turn.config
			? {
					...splitKey(turn.config.sidekickModelKey),
					usage: sidekickUsage,
				}
			: undefined;
		const fastContextUsage = turn.fastContextParts.length
			? sumUsage(turn.fastContextParts)
			: undefined;
		return {
			...cell,
			usage: {
				...sumUsage([main, ...turn.fusionParts, ...turn.fastContextParts]),
				provider: main.provider,
				model: main.model,
				// Main's elapsed span already includes waiting for helpers.
				durationMs: main.durationMs,
				...(turn.config ? { fusion: { lead, sidekick: sidekick!, unattributed,
					attributionAmbiguous: sameModel || !!unattributed,
					breakdown: fusionBreakdown([
						...mainParts.map((usage) => ({ turnTimestamp: turnTimestamp!, source: "main" as const, usage })),
						...turn.records.map((record) => ({ ...record, source: "auxiliary" as const })),
						...turn.fastContextParts.map((usage) => ({ turnTimestamp: turnTimestamp!, source: "fast-context" as const, usage })),
					]) } } : {}),
				...(fastContextUsage
					? {
							fastContext: {
								primary: main,
								search: {
									provider: fastContextUsage.provider,
									model: fastContextUsage.model,
									usage: fastContextUsage,
								},
							},
						}
					: {}),
			},
		};
	});
}
