import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { FAST_CONTEXT_USAGE_ENTRY, FUSION_TASK_METRIC_ENTRY, FUSION_USAGE_ENTRY,
	type FusionTaskMetric } from "./fusion-usage";

export interface FusionEvalRun {
	costUsd?: number;
	unpricedCalls: number;
	modelCalls: number;
	cacheRead: number;
	helperCalls: number;
	helperCostUsd?: number;
	workers: number;
	escalations: number;
	unverifiedCriteria: number;
}

type RecordedUsage = { cost?: { total?: number }; cacheRead?: number };

/** Read the active branch only. Missing prices remain unknown rather than becoming free. */
export function summarizeFusionRun(entries: readonly SessionEntry[]): FusionEvalRun {
	let costUsd = 0;
	let helperCostUsd = 0;
	let unpricedCalls = 0;
	let helperUnpricedCalls = 0;
	let modelCalls = 0;
	let helperCalls = 0;
	let cacheRead = 0;
	let workers = 0;
	let escalations = 0;
	let unverifiedCriteria = 0;
	const seenHelperSources = new Set<string>();
	const seenTasks = new Set<string>();
	const addUsage = (usage: RecordedUsage | undefined, helper = false, helperPrice?: number) => {
		if (!usage) return;
		modelCalls++;
		cacheRead += Number.isFinite(usage.cacheRead) ? usage.cacheRead! : 0;
		if (helper) helperCalls++;
		const price = helper ? helperPrice : usage.cost?.total;
		if (Number.isFinite(price) && price! >= 0) {
			costUsd += price!;
			if (helper) helperCostUsd += price!;
		} else {
			unpricedCalls++;
			if (helper) helperUnpricedCalls++;
		}
	};
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant")
			addUsage(entry.message.usage);
		else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary")
			addUsage(entry.usage);
		else if (entry.type === "custom" && [FUSION_USAGE_ENTRY, FAST_CONTEXT_USAGE_ENTRY].includes(entry.customType)) {
			const record = entry.data as { sourceEntryId?: string; usage?: { costUsd?: number; cacheRead?: number } } | undefined;
			if (!record?.usage) continue;
			if (record.sourceEntryId && seenHelperSources.has(record.sourceEntryId)) continue;
			if (record.sourceEntryId) seenHelperSources.add(record.sourceEntryId);
			addUsage(record.usage, true, record.usage.costUsd);
		} else if (entry.type === "custom" && entry.customType === FUSION_TASK_METRIC_ENTRY) {
			const metric = entry.data as FusionTaskMetric | undefined;
			if (!metric?.taskId || seenTasks.has(metric.taskId)) continue;
			seenTasks.add(metric.taskId);
			if (metric.kind === "worker") workers++;
			if (metric.outcome === "needs_escalation") escalations++;
			unverifiedCriteria += metric.acceptance?.unverified ?? 0;
		}
	}
	return { ...(unpricedCalls ? {} : { costUsd }), unpricedCalls, modelCalls, cacheRead,
		helperCalls, ...(helperUnpricedCalls ? {} : { helperCostUsd }), workers, escalations,
		unverifiedCriteria };
}

export interface FusionEvalPair {
	id: string;
	lead: FusionEvalRun;
	fusion: FusionEvalRun;
	/** Judged against the same acceptance criteria, independently of model self-reports. */
	leadPass?: boolean;
	fusionPass?: boolean;
}

export function compareFusionRuns(pairs: readonly FusionEvalPair[]) {
	const judged = pairs.filter((pair) => pair.leadPass !== undefined && pair.fusionPass !== undefined);
	const priced = pairs.filter((pair) => pair.lead.costUsd !== undefined && pair.fusion.costUsd !== undefined);
	const comparable = judged.filter((pair) => pair.lead.costUsd !== undefined && pair.fusion.costUsd !== undefined);
	const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
	const leadCost = sum(comparable.map((pair) => pair.lead.costUsd!));
	const fusionCost = sum(comparable.map((pair) => pair.fusion.costUsd!));
	const leadPasses = judged.filter((pair) => pair.leadPass).length;
	const fusionPasses = judged.filter((pair) => pair.fusionPass).length;
	const comparableLeadPasses = comparable.filter((pair) => pair.leadPass).length;
	const comparableFusionPasses = comparable.filter((pair) => pair.fusionPass).length;
	return {
		tasks: pairs.length, judged: judged.length, priced: priced.length, comparable: comparable.length,
		leadPasses, fusionPasses,
		...(judged.length ? { leadPassRate: leadPasses / judged.length, fusionPassRate: fusionPasses / judged.length,
			qualityGapPp: 100 * (fusionPasses - leadPasses) / judged.length } : {}),
		...(comparable.length ? { leadCostUsd: leadCost, fusionCostUsd: fusionCost,
			costChange: leadCost > 0 ? fusionCost / leadCost - 1 : undefined,
			leadCostPerPassUsd: comparableLeadPasses ? leadCost / comparableLeadPasses : undefined,
			fusionCostPerPassUsd: comparableFusionPasses ? fusionCost / comparableFusionPasses : undefined } : {}),
		unpricedCalls: sum(pairs.map((pair) => pair.lead.unpricedCalls + pair.fusion.unpricedCalls)),
		fusionEscalations: sum(pairs.map((pair) => pair.fusion.escalations)),
		fusionUnverifiedCriteria: sum(pairs.map((pair) => pair.fusion.unverifiedCriteria)),
	};
}
