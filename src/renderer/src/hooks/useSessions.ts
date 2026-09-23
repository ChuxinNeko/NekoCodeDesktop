import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../../../shared/agent";
import { api, errorMessage } from "../api";

const SESSIONS_CHANGED_DEBOUNCE_MS = 200;

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
 * Owns the sidebar's session list across all project directories.
 *
 * The list is authoritative on disk, so mutations write through the bridge and
 * re-read rather than patching local state — main also pushes
 * `onSessionsChanged` whenever a run names a session or finishes, and the two
 * paths have to converge on the same thing.
 */
export function useSessions(): SessionsState {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// An older refresh must not overwrite newer rows or update an unmounted list.
	const requestRef = useRef(0);

	const load = useCallback(
		async () => {
			const request = ++requestRef.current;
			setLoading(true);
			try {
				const next = await api.sessionList();
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
		void load();
	}, [load]);

	useEffect(() => {
		void load();
		return () => { requestRef.current++; };
	}, [load]);

	// Several tasks settling at once, or a run starting and naming itself, each
	// push a change; listing re-reads every transcript on disk, so a burst is
	// answered with one read once it has passed.
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = api.onSessionsChanged(() => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				refresh();
			}, SESSIONS_CHANGED_DEBOUNCE_MS);
		});
		return () => {
			if (timer) clearTimeout(timer);
			unsubscribe();
		};
	}, [refresh]);

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
