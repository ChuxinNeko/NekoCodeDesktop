import type { AgentCell } from "../../../shared/agent";

export interface PredictionContext { sessionId: string; cells: readonly AgentCell[] }

/** Only the latest user/finished answer pair; never tool output or reasoning. */
export function predictionTurn(context: PredictionContext | undefined): { key: string; userText: string; answerText: string } | null {
	if (!context) return null;
	const last = context.cells[context.cells.length - 1];
	if (last?.type !== "assistant" || last.streaming || last.error || !last.text.trim()) return null;
	for (let index = context.cells.length - 2; index >= 0; index--) {
		const cell = context.cells[index];
		if (cell.type === "user") return cell.text.trim() ? { key: JSON.stringify([context.sessionId, cell.id, last.id]), userText: cell.text, answerText: last.text } : null;
	}
	return null;
}

export function canAcceptPrediction(key: string, shift: boolean, ctrl: boolean, alt: boolean, meta: boolean, composing: boolean): boolean {
	return key === "Tab" && !shift && !ctrl && !alt && !meta && !composing;
}
