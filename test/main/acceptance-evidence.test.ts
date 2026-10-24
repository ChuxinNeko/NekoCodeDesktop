import { expect, test } from "bun:test";
import type { AgentCell } from "../../src/shared/agent";
import { buildAcceptanceReport } from "../../src/shared/acceptance";
import { ACCEPTANCE_EVIDENCE_ENTRY, AcceptanceEvidenceRecorder, withAcceptanceEvidence } from "../../src/main/acceptance-evidence";

test("parallel worker evidence survives history reconstruction, remains attributed, and invalidates checks", () => {
	const cells: AgentCell[] = [{ id: "u", type: "user", text: "Implement", timestamp: 1 }];
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	let now = 2;
	const recorder = new AcceptanceEvidenceRecorder(() => cells, data => entries.push({ type: "custom", customType: ACCEPTANCE_EVIDENCE_ENTRY, data }), () => now++);
	recorder.handle({ type: "tool_execution_start", toolCallId: "test", toolName: "bash", args: { command: "bun test" } }, "worker-1");
	recorder.handle({ type: "tool_execution_end", toolCallId: "test", toolName: "bash", result: { content: [{ type: "text", text: "2 pass" }], details: { execution: { exitCode: 0 } } }, isError: false }, "worker-1");
	const restored = withAcceptanceEvidence(cells, JSON.parse(JSON.stringify(entries)));
	expect(restored).toHaveLength(2);
	const check = buildAcceptanceReport(restored).turns[0].checks[0];
	expect(check).toMatchObject({ toolCallId: "helper:worker-1:test", status: "passed", output: "2 pass" });
	recorder.handle({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "a.ts" } }, "worker-2");
	expect(buildAcceptanceReport(withAcceptanceEvidence(cells, entries), true).turns[0].checks[0].status).toBe("stale");
});

test("malformed metadata cannot break history, and writes do not duplicate file bodies", () => {
	const cells: AgentCell[] = [{ id: "u", type: "user", text: "Implement", timestamp: 1 }];
	const entries: Array<{ type: string; customType: string; data: unknown }> = [{ type: "custom", customType: ACCEPTANCE_EVIDENCE_ENTRY, data: { turnId: "u", cell: { type: "tool", toolCallId: "bad", toolName: "bash", timestamp: 2 } } }];
	expect(withAcceptanceEvidence(cells, entries)).toEqual(cells);
	const recorder = new AcceptanceEvidenceRecorder(() => cells, data => entries.push({ type: "custom", customType: ACCEPTANCE_EVIDENCE_ENTRY, data }));
	recorder.handle({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "a.ts", content: "large source" } }, "worker");
	expect(JSON.stringify(entries.at(-1))).not.toContain("large source");
});
