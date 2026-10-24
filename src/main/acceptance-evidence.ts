import type { AgentCell } from "../shared/agent";
import type { ProjectionEvent } from "./agent-projection";
import { toolOutputText } from "./agent-projection";
import { isShellTool } from "../shared/hooks";

export const ACCEPTANCE_EVIDENCE_ENTRY = "nekocode.acceptance.evidence.v1";
type Tool = Extract<AgentCell, { type: "tool" }>;
interface EvidenceEntry { turnId: string; cell: Tool }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Worker executions are stored as metadata, without duplicating their chat transcript. */
export class AcceptanceEvidenceRecorder {
	private pending = new Map<string, EvidenceEntry>();
	constructor(private getCells: () => readonly AgentCell[], private save: (entry: EvidenceEntry) => void, private now = Date.now) {}
	handle(event: ProjectionEvent, source: string): void {
		if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
		const key = `helper:${source}:${event.toolCallId}`;
		if (event.type === "tool_execution_start") {
			if (!isShellTool(event.toolName) && !["edit", "write", "ast_edit", "apply_patch", "browser_check"].includes(event.toolName)) return;
			const turn = this.getCells().findLast(cell => cell.type === "user");
			if (!turn) return;
			const timestamp = this.now();
			const args = object(event.args);
			// A file edit only needs its path here, not a second copy of the whole source.
			const savedArgs = isShellTool(event.toolName) ? { command: args.command } : event.toolName === "browser_check" ? { title: args.title } : { path: args.path };
			const entry: EvidenceEntry = { turnId: turn.id, cell: { id: `tool-${key}`, type: "tool", toolCallId: key, toolName: event.toolName,
				args: savedArgs, status: "running", output: "", startedAt: timestamp, timestamp } };
			this.pending.set(key, entry); this.save(entry);
		} else {
			const entry = this.pending.get(key);
			if (!entry) return;
			this.pending.delete(key);
			const details = object(object(event.result).details);
			this.save({ ...entry, cell: { ...entry.cell, status: event.isError ? "error" : "done", timestamp: this.now(),
				output: toolOutputText(event.result).slice(-10_000), details: {
					...(details.execution ? { execution: details.execution } : {}),
					...(details.acceptanceEvidence ? { acceptanceEvidence: details.acceptanceEvidence } : {}),
				} } });
		}
	}
}

export function withAcceptanceEvidence(cells: readonly AgentCell[], entries: readonly { type: string; customType?: string; data?: unknown }[]): AgentCell[] {
	const byTurn = new Map<string, Map<string, Tool>>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ACCEPTANCE_EVIDENCE_ENTRY) continue;
		const data = object(entry.data), cell = object(data.cell);
		if (typeof data.turnId !== "string" || cell.type !== "tool" || typeof cell.id !== "string" || typeof cell.toolCallId !== "string" || typeof cell.toolName !== "string" || typeof cell.timestamp !== "number" || typeof cell.output !== "string" || !["running", "done", "error"].includes(String(cell.status))) continue;
		const tools = byTurn.get(data.turnId) ?? new Map<string, Tool>();
		tools.set(cell.toolCallId, cell as Tool); byTurn.set(data.turnId, tools);
	}
	const result: AgentCell[] = [];
	let turnId: string | undefined;
	const flush = () => { if (turnId) result.push(...byTurn.get(turnId)?.values() ?? []); };
	for (const cell of cells) {
		if (cell.type === "user") { flush(); turnId = cell.id; }
		result.push(cell);
	}
	flush();
	return result;
}
