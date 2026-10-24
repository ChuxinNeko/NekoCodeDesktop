import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { AgentCell } from "../shared/agent";
import { buildAcceptanceReport, requirementStatus } from "../shared/acceptance";

export const ACCEPTANCE_TOOL_NAME = "acceptance_check";
const schema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 80 }),
	title: Type.String({ minLength: 1, maxLength: 240 }),
	status: Type.Union(["pending", "passed", "failed", "skipped", "unverified"].map(value => Type.Literal(value))),
	reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	evidenceToolCallIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 12, uniqueItems: true })),
}, { additionalProperties: false });

export function createAcceptanceTool(getCells: () => readonly AgentCell[]): ToolDefinition {
	return {
		name: ACCEPTANCE_TOOL_NAME, label: ACCEPTANCE_TOOL_NAME, parameters: schema, executionMode: "sequential",
		description: "Plan and update an acceptance criterion for the current user turn. Reuse its id to update it. Declare pending before work; skipped/unverified require an honest reason. Passed/failed require evidenceToolCallIds from actual completed validation commands or browser_check in THIS turn. Run one validation command per call: a zero exit code for compound scripts, pipelines or redirected commands may mask failures and is treated as unverified. Successful navigation, arbitrary evaluate output and your own prose are not passing evidence. Source changes invalidate earlier results. Tool execution records persist with the conversation; do not claim the entire task is verified just because some checks pass.",
		async execute(_id, params, signal) {
			if (signal?.aborted) throw new Error("Acceptance update cancelled");
			const input = params as Static<typeof schema>;
			if (!input.id.trim() || !input.title.trim()) throw new Error("Acceptance id and title cannot be blank");
			if ((input.status === "skipped" || input.status === "unverified") && !input.reason?.trim()) throw new Error("Skipped or unverified checks require a reason");
			const current = buildAcceptanceReport(getCells(), true, input.evidenceToolCallIds).turns.at(-1);
			if (!current) throw new Error("No user turn to attach acceptance criteria to");
			const ids = input.evidenceToolCallIds ?? [];
			const evidence = ids.map(id => current.checks.find(check => check.toolCallId === id && check.kind !== "requirement"));
			if (evidence.some(check => !check)) throw new Error("Evidence must reference observed validation checks in the current turn");
			if ((input.status === "passed" || input.status === "failed") && requirementStatus(input.status, evidence.filter(check => !!check)) !== input.status) {
				throw new Error("Evidence does not support this status. Run a validation command or browser_check after the latest source change, or mark the criterion unverified with a reason.");
			}
			const acceptanceRecord = { ...input, id: input.id.trim(), title: input.title.trim(), evidenceToolCallIds: ids };
			return { content: [{ type: "text", text: JSON.stringify(acceptanceRecord) }], details: { acceptanceRecord } };
		},
	};
}
