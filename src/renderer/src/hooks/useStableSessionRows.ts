import { useState } from "react";
import type { SessionSummary } from "../../../shared/agent";
import { reconcileSessionRows } from "../../../shared/sessions";

/** App-owned order survives sidebar unmounts, project switches, and native/ACP snapshot updates. */
export function useStableSessionRows(incoming: SessionSummary[]): SessionSummary[] {
	const [state, setState] = useState(() => ({ incoming, rows: reconcileSessionRows([], incoming) }));
	if (state.incoming === incoming) return state.rows;
	// Derive before committing, so a refresh never paints the server's transient sort order.
	const next = { incoming, rows: reconcileSessionRows(state.rows, incoming) };
	setState(next);
	return next.rows;
}
