import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../../../shared/agent";
import { api, errorMessage } from "../api";

export interface SessionsState {
	sessions: SessionSummary[];
	loading: boolean;
	error: string | null;
	refresh: () => void;
	rename: (session: SessionSummary, title: string) => Promise<void>;
	remove: (session: SessionSummary) => Promise<void>;
	dismissError: () => void;
}

/**
 * Owns the session list for one project directory.
 *
 * The list is authoritative on disk, so mutations write through the bridge and
 * re-read rather than patching local state — main also pushes
 * `onSessionsChanged` whenever a run names a session or finishes, and the two
 * paths have to converge on the same thing.
 */
export function useSessions(cwd: string | null): SessionsState {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Guards against an in-flight list for an old project (or an older refresh)
	// landing after a newer one and resurrecting stale rows.
	const requestRef = useRef(0);

	const load = useCallback(
		async (target: string) => {
			const request = ++requestRef.current;
			setLoading(true);
			try {
				const next = await api.sessionList(target);
				if (request === requestRef.current) {
					setSessions(next);
					setError(null);
				}
			} catch (cause) {
				if (request === requestRef.current) setError(errorMessage(cause));
			} finally {
				if (request === requestRef.current) setLoading(false);
			}
		},
		[],
	);

	const refresh = useCallback(() => {
		if (cwd) void load(cwd);
	}, [cwd, load]);

	useEffect(() => {
		if (!cwd) {
			requestRef.current++;
			setSessions([]);
			setError(null);
			setLoading(false);
			return;
		}
		void load(cwd);
	}, [cwd, load]);

	useEffect(() => api.onSessionsChanged(() => refresh()), [refresh]);

	const rename = useCallback(
		async (session: SessionSummary, title: string) => {
			try {
				await api.sessionRename({
					sessionFile: session.sessionFile,
					cwd: session.cwd,
					title,
				});
			} catch (cause) {
				setError(errorMessage(cause));
				refresh();
			}
		},
		[refresh],
	);

	const remove = useCallback(
		async (session: SessionSummary) => {
			try {
				await api.sessionDelete({ sessionFile: session.sessionFile });
			} catch (cause) {
				setError(errorMessage(cause));
				refresh();
			}
		},
		[refresh],
	);

	return {
		sessions,
		loading,
		error,
		refresh,
		rename,
		remove,
		dismissError: useCallback(() => setError(null), []),
	};
}
