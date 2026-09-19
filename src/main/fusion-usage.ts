import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentCell, TurnUsage } from "../shared/agent";
import { isFusionConfig, type FusionConfig } from "../shared/fusion";
import { FUSION_ENTRY } from "./fusion-config";

/** Custom entries stay out of the model context but survive session reopening. */
export const FUSION_USAGE_ENTRY = "nekocode.fusion-usage.v1";

export interface FusionUsageRecord {
	turnTimestamp: number;
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
	return record;
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

/** Join by the originating prompt, never by the current picker or finish time. */
export function withFusionUsage(
	cells: AgentCell[],
	entries: readonly SessionEntry[],
	helpersRunning = false,
): AgentCell[] {
	let config: FusionConfig | undefined;
	let latestTurn: number | undefined;
	const turns = new Map<number, { config: FusionConfig; parts: TurnUsage[] }>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === FUSION_ENTRY) {
			config = isFusionConfig(entry.data) ? entry.data : undefined;
		} else if (entry.type === "message" && entry.message.role === "user") {
			latestTurn = entry.message.timestamp;
			if (config) turns.set(latestTurn, { config, parts: [] });
		} else if (entry.type === "custom" && entry.customType === FUSION_USAGE_ENTRY) {
			const record = readRecord(entry.data);
			if (record) turns.get(record.turnTimestamp)?.parts.push(record.usage);
		}
	}
	let turnTimestamp: number | undefined;
	return cells.map((cell) => {
		if (cell.type === "user") turnTimestamp = cell.timestamp;
		if (cell.type !== "assistant" || !cell.usage || turnTimestamp === undefined) return cell;
		const turn = turns.get(turnTimestamp);
		if (!turn) return cell;
		if (helpersRunning && turnTimestamp === latestTurn) return { ...cell, usage: undefined };
		const lead = cell.usage;
		const sidekickUsage = turn.parts.length ? sumUsage(turn.parts) : undefined;
		const separator = turn.config.sidekickModelKey.indexOf("/");
		const sidekick = {
			provider: turn.config.sidekickModelKey.slice(0, separator),
			model: turn.config.sidekickModelKey.slice(separator + 1),
			usage: sidekickUsage,
		};
		return {
			...cell,
			usage: {
				...sumUsage([lead, ...turn.parts]),
				provider: lead.provider,
				model: lead.model,
				// Lead's elapsed span already includes waiting for Sidekick.
				durationMs: lead.durationMs,
				fusion: { lead, sidekick },
			},
		};
	});
}
