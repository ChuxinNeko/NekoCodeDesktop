import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TASK_OUTCOMES, type FusionTaskReport } from "../shared/workflow";

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

export function createFusionReportTool(report: (value: FusionTaskReport) => void): ToolDefinition {
	return {
		name: FUSION_REPORT_TOOL, label: "Report Fusion outcome",
		description: "Before finishing a Fusion implementation task, report acceptance coverage and whether Lead must decide or take over. completed means implementation is ready for review, not that tool success proves acceptance. blocked is environmental; needs_escalation is a capability/correctness issue, not any failed test. Never invent checks.",
		parameters: Type.Object({
			outcome: Type.Union(TASK_OUTCOMES.map((value) => Type.Literal(value))),
			summary: Type.String({ minLength: 1, maxLength: 2000 }),
			acceptance: Type.Array(Type.Object({
				criterion: Type.String({ minLength: 1, maxLength: 2000 }),
				status: Type.Union([Type.Literal("met"), Type.Literal("unverified"), Type.Literal("not_met")]),
				evidence: Type.String({ maxLength: 2000 }),
			}, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
			decision: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
		}, { additionalProperties: false }),
		async execute(_id, args) {
			const value = args as FusionTaskReport;
			if (value.outcome !== "completed" && !value.decision?.trim())
				throw new Error("A blocked/decision/escalation report needs concrete evidence and a question for Lead");
			if (value.acceptance.some((item) => item.status === "met" && !item.evidence.trim()))
				throw new Error("Met acceptance requires evidence; use unverified when checks were not performed");
			if (value.outcome === "completed" && value.acceptance.some((item) => item.status === "not_met"))
				throw new Error("Unmet acceptance cannot be reported as completed; ask Lead for a decision");
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
	].join("\n") : "Sidekick did not provide a structured acceptance report; Lead must review unverified work.\n\n" + text;
	return {
		text: details.length > 5000 ? details.slice(0, 5000) + "\n[Report excerpt; remaining acceptance is not proven here.]" : details,
		outcome: report?.outcome ?? "needs_decision" as const,
	};
}
