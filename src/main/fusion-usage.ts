import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentCell, TurnUsage } from "../shared/agent";
import { isFusionConfig, type FusionConfig } from "../shared/fusion";
import { FUSION_ENTRY } from "./fusion-config";

/** Custom entries stay out of the model context but survive session reopening. */
export const FUSION_USAGE_ENTRY = "nekocode.fusion-usage.v1";
export const FAST_CONTEXT_USAGE_ENTRY = "nekocode.fast-context-usage.v1";

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
		for (const key of ["reasoning", "costUsd", "modelMs", "durationMs"] as const) {
			if (part[key] !== undefined) result[key] = (result[key] ?? 0) + part[key];
		}
		if (part.responseModel) result.responseModel = part.responseModel;
	}
	return result;
}

function fusionBreakdown(records: FusionUsageRecord[]): NonNullable<NonNullable<TurnUsage["fusion"]>["breakdown"]> {
	const groups = new Map<string, { taskId?: string; kind: FusionUsageKind; parts: TurnUsage[] }>();
	for (const record of records) {
		const kind = record.kind ?? "inference";
		const key = JSON.stringify([record.taskId, kind, record.usage.provider, record.usage.model, record.usage.responseModel]);
		let group = groups.get(key);
		if (!group) groups.set(key, group = { taskId: record.taskId, kind, parts: [] });
		group.parts.push(record.usage);
	}
	return [...groups.values()].map(({ taskId, kind, parts }) => ({ taskId, kind, usage: sumUsage(parts) }));
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
		{ config?: FusionConfig; fusionParts: TurnUsage[]; fastContextParts: TurnUsage[]; records: FusionUsageRecord[]; userEntryId: string }
	>();
	const seenSources = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === FUSION_ENTRY) {
			config = isFusionConfig(entry.data) ? entry.data : undefined;
		} else if (entry.type === "message" && entry.message.role === "user") {
			latestTurn = entry.message.timestamp;
			turns.set(latestTurn, { config, fusionParts: [], fastContextParts: [], records: [], userEntryId: entry.id });
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
			if (record) turns.get(record.turnTimestamp)?.fastContextParts.push(record.usage);
		}
	}
	let turnTimestamp: number | undefined;
	return cells.map((cell) => {
		if (cell.type === "user") turnTimestamp = cell.timestamp;
		if (cell.type !== "assistant" || !cell.usage || turnTimestamp === undefined) return cell;
		const turn = turns.get(turnTimestamp);
		if (!turn || (!turn.config && !turn.fastContextParts.length)) return cell;
		if (helpersRunning && turnTimestamp === latestTurn) return { ...cell, usage: undefined };
		const lead = cell.usage;
		const sidekickUsage = turn.fusionParts.length ? sumUsage(turn.fusionParts) : undefined;
		const sidekick = turn.config
			? {
					provider: turn.config.sidekickModelKey.slice(0, turn.config.sidekickModelKey.indexOf("/")),
					model: turn.config.sidekickModelKey.slice(turn.config.sidekickModelKey.indexOf("/") + 1),
					usage: sidekickUsage,
				}
			: undefined;
		const fastContextUsage = turn.fastContextParts.length
			? sumUsage(turn.fastContextParts)
			: undefined;
		return {
			...cell,
			usage: {
				...sumUsage([lead, ...turn.fusionParts, ...turn.fastContextParts]),
				provider: lead.provider,
				model: lead.model,
				// Lead's elapsed span already includes waiting for Sidekick.
				durationMs: lead.durationMs,
				...(turn.config ? { fusion: { lead, sidekick: sidekick!, breakdown: fusionBreakdown(turn.records) } } : {}),
				...(fastContextUsage
					? {
							fastContext: {
								primary: lead,
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
