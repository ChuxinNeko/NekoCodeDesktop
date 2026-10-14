import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskInput, WorkflowTask } from "../shared/workflow";
import { FusionInlineHandoffState, FUSION_COMPACT_HANDOFF_SCHEMA, FUSION_RESUME_HANDOFF_SCHEMA } from "./fusion-handoff";

interface FusionParallelHost {
	handoffs: FusionInlineHandoffState;
	assertAvailable(name: string): void;
	start(input: TaskInput): WorkflowTask;
}

/** Native task lifecycle owns cancellation, write leases, events and result delivery. */
export function createFusionParallelTools(task: ToolDefinition, host: FusionParallelHost): ToolDefinition[] {
	const properties = (task.parameters as { properties: Record<string, any> }).properties;
	return [{
		name: "fusion_implement", label: "Fusion implementation", executionMode: "sequential",
		description: "Start a bounded background assignment in the independent, persistent Sidekick session. Supply instruction, path/paths, acceptanceCriterion and check or skipReason; or a full worker executionPlan and writablePaths. Resume a correction with resume=true, instruction and resolution. Explicitly include necessary evidence and user restrictions: Sidekick does not receive the Lead transcript. Lead remains on its model and may continue independent work. Completion automatically returns a bounded report for Lead review; do not poll.",
		parameters: Type.Object(Object.fromEntries(Object.entries({ ...properties,
			...FUSION_COMPACT_HANDOFF_SCHEMA.properties, ...FUSION_RESUME_HANDOFF_SCHEMA.properties,
		}).map(([name, schema]) => [name, Type.Optional(schema)])), { additionalProperties: false }),
		execute: async (_id, args, signal) => {
			if (signal?.aborted) throw new Error("Fusion assignment cancelled");
			host.assertAvailable("fusion_implement");
			const input = host.handoffs.prepare(args);
			const result = host.start(input);
			host.handoffs.accept(input);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	}, {
		name: "fusion_investigate", label: "Fusion investigation", executionMode: "sequential",
		description: "Start a bounded read-only background assignment in the independent persistent Sidekick session. Supply concrete evidence questions, paths, known facts, user restrictions and stopping conditions. Lead continues independent analysis and owns decisions. Completion automatically returns evidence and unknowns; do not poll. No editing or shell access is granted.",
		parameters: Type.Object({ instruction: Type.String({ minLength: 1, maxLength: 6000 }) }, { additionalProperties: false }),
		execute: async (_id, args, signal) => {
			if (signal?.aborted) throw new Error("Fusion assignment cancelled");
			host.assertAvailable("fusion_investigate");
			const instruction = (args as { instruction: string }).instruction;
			if (typeof instruction !== "string" || !instruction.trim() || instruction.length > 6000)
				throw new Error("Provide a bounded evidence request");
			const result = host.start({ kind: "explore", description: instruction.slice(0, 200),
				prompt: instruction, writablePaths: [] });
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	}];
}
