import type { SessionSummary } from "./agent";
import type { AcpHistoryEntry, AcpSessionSummary } from "./acp";

/**
 * The sidebar key of an ACP conversation. Keyed by the agent's own session id
 * when there is one, so a conversation that is both open here and listed in
 * the agent's history is one row; a brand-new one that the agent has not named
 * yet goes by NekoCode's local id until it has.
 */
export function acpRowKey(agentId: string, session: { agentSessionId?: string; id: string }): string {
	return session.agentSessionId ? `acp:${agentId}:${session.agentSessionId}` : `acp:${agentId}:local:${session.id}`;
}

export function acpHistoryKey(agentId: string, entry: AcpHistoryEntry): string {
	return `acp:${agentId}:${entry.sessionId}`;
}

/** What opening a row needs: either the open session, or the history entry to load. */
export type AcpRowTarget =
	| { kind: "live"; sessionId: string }
	| { kind: "history"; entry: AcpHistoryEntry };

/**
 * One agent's conversations as sidebar rows: those open in NekoCode, then the
 * agent's own history, one row per conversation, newest first.
 */
export function acpSessionRows(
	agentId: string,
	history: readonly AcpHistoryEntry[],
	live: readonly AcpSessionSummary[],
): { rows: SessionSummary[]; targets: Map<string, AcpRowTarget> } {
	const targets = new Map<string, AcpRowTarget>();
	const rows: SessionSummary[] = [];
	const liveHere = live.filter((session) => session.agentId === agentId);
	const openIds = new Set(liveHere.flatMap((session) => (session.agentSessionId ? [session.agentSessionId] : [])));

	for (const session of liveHere) {
		// Opened ahead of a first message that has not been sent: not a row yet.
		if (session.pristine) continue;
		const key = acpRowKey(agentId, session);
		const listed = history.find((entry) => entry.sessionId === session.agentSessionId);
		targets.set(key, { kind: "live", sessionId: session.id });
		rows.push({
			id: key,
			sessionFile: key,
			cwd: session.cwd,
			// A title the agent gave the conversation beats NekoCode's fallback.
			title: listed?.title && session.title === session.agentName ? listed.title : session.title,
			titlePending: false,
			preview: "",
			createdAt: session.createdAt,
			// Opening an old conversation is not activity in it: the agent's own
			// time stands until a turn ends and the history is read again.
			updatedAt: listed ? listed.updatedAt : session.updatedAt,
			messageCount: 0,
			running: session.status === "prompting" || session.status === "starting",
		});
	}
	for (const entry of history) {
		if (openIds.has(entry.sessionId)) continue;
		const key = acpHistoryKey(agentId, entry);
		targets.set(key, { kind: "history", entry });
		rows.push({
			id: key,
			sessionFile: key,
			cwd: entry.cwd,
			title: entry.title || "未命名会话",
			titlePending: false,
			preview: "",
			createdAt: entry.updatedAt,
			updatedAt: entry.updatedAt,
			messageCount: 0,
		});
	}
	rows.sort((a, b) => b.updatedAt - a.updatedAt);
	return { rows, targets };
}
