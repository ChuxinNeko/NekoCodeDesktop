import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TASK_OUTCOMES, type FusionTaskReport } from "../shared/workflow";
import type { FusionRoutingSignal } from "./fusion-routing";

export const FUSION_MODEL_ROUTE_TOOL = "fusion_route_model";
/** An evidence hint, not an instruction to switch models or an authorization grant. */
export function createFusionModelRouteTool(request: (value: FusionRoutingSignal, signal?: AbortSignal) => Promise<unknown>): ToolDefinition {
	return {
		name: FUSION_MODEL_ROUTE_TOOL, label: "Report Fusion routing evidence",
		description: "Report the next workload, correctness risk and concrete evidence to the Fusion runtime. This only queues a routing hint; it does NOT switch models immediately. The runtime combines it with observed execution results at a natural context compaction boundary. Do not force compaction or infer capability problems from a single test/network failure. If safeToContinue=false, stop unsafe work and return blocked for environmental problems or needs_escalation for capability/correctness problems; do not wait or keep retrying to trigger routing. Permissions, write scope and task decisions remain unchanged.",
		parameters: Type.Object({
			workload: Type.Union(["routine", "investigation", "planning", "review"].map((value) => Type.Literal(value))),
			risk: Type.Union(["low", "unknown", "high"].map((value) => Type.Literal(value))),
			reason: Type.String({ minLength: 1, maxLength: 1000 }),
			evidence: Type.String({ minLength: 1, maxLength: 2000 }),
			safeToContinue: Type.Optional(Type.Boolean()),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, args, signal) {
			if (signal?.aborted) throw new Error("Fusion routing cancelled");
			const details = await request(args as FusionRoutingSignal, signal);
			return { content: [{ type: "text", text: "Routing evidence recorded, not a model switch. " + JSON.stringify(details) }], details };
		},
	};
}

export const FUSION_REPORT_TOOL = "fusion_report";
export const FUSION_UPGRADE_TOOL = "fusion_request_upgrade";
export interface FusionUpgradeRequest { reason: string; evidence: string }
export function createFusionUpgradeTool(request: (value: FusionUpgradeRequest) => void): ToolDefinition {
	return {
		name: FUSION_UPGRADE_TOOL, label: "Request Fusion upgrade",
		description: "Request the user-configured Lead model for a specific correctness/capability problem. Include concrete evidence, not an ordinary test or network failure. The runtime may switch only at the next context compaction boundary, not now. If no boundary occurs and safe progress is impossible, report needs_escalation and return to Lead. Do not force compaction or keep failing to trigger an upgrade.",
		parameters: Type.Object({
			reason: Type.String({ minLength: 1, maxLength: 1000 }),
			evidence: Type.String({ minLength: 1, maxLength: 2000 }),
		}, { additionalProperties: false }),
		async execute(_id, args) {
			request(args as FusionUpgradeRequest);
			return { content: [{ type: "text", text: "Upgrade requested, not executed. Continue only safe work; if blocked, report needs_escalation to Lead." }], details: args };
		},
	};
}

export function createFusionReportTool(report: (value: FusionTaskReport) => void, allowEmptyAcceptance = false): ToolDefinition {
	return {
		name: FUSION_REPORT_TOOL, label: "Report Fusion outcome",
		description: "Before finishing a Fusion implementation task, report acceptance coverage and whether the parent agent must decide or take over. The worker may itself use either Lead or Sidekick; model selection does not grant parent decision authority. completed means implementation is ready for review, not that tool success proves acceptance. blocked is environmental; needs_escalation is a capability/correctness issue, not any failed test. Never invent checks.",
		parameters: Type.Object({
			outcome: Type.Union(TASK_OUTCOMES.map((value) => Type.Literal(value))),
			summary: Type.String({ minLength: 1, maxLength: 2000 }),
			acceptance: Type.Array(Type.Object({
				criterion: Type.String({ minLength: 1, maxLength: 2000 }),
				status: Type.Union([Type.Literal("met"), Type.Literal("unverified"), Type.Literal("not_met")]),
				evidence: Type.String({ maxLength: 2000 }),
			}, { additionalProperties: false }), { minItems: allowEmptyAcceptance ? 0 : 1, maxItems: 20 }),
			decision: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
		}, { additionalProperties: false }),
		async execute(_id, args) {
			const value = args as FusionTaskReport;
			if (value.outcome !== "completed" && !value.decision?.trim())
				throw new Error("A blocked/decision/escalation report needs concrete evidence and a question for the parent agent");
			if (value.acceptance.some((item) => item.status === "met" && !item.evidence.trim()))
				throw new Error("Met acceptance requires evidence; use unverified when checks were not performed");
			if (value.outcome === "completed" && value.acceptance.some((item) => item.status === "not_met"))
				throw new Error("Unmet acceptance cannot be reported as completed; ask the parent agent for a decision");
			report(value);
			return { content: [{ type: "text", text: "Outcome recorded. Finish with a concise handoff; do not start another task." }], details: value };
		},
	};
}

/** Only a fresh per-task report is used; never infer acceptance from run status. */
export function fusionTaskResult(text: string, report?: FusionTaskReport) {
	const details = report ? [
		`Outcome: ${report.outcome}\n${report.summary}`,
		...report.acceptance.map((item) => `${item.status}: ${item.criterion.slice(0, 100)} — ${item.evidence.slice(0, 150)}`),
		...(report.decision ? [`Lead decision: ${report.decision}`] : []),
		text,
	].join("\n") : "The Fusion worker did not provide a structured acceptance report; the parent agent must review unverified work.\n\n" + text;
	return {
		text: details.length > 5000 ? details.slice(0, 5000) + "\n[Report excerpt; remaining acceptance is not proven here.]" : details,
		outcome: report?.outcome ?? "needs_decision" as const,
	};
}
