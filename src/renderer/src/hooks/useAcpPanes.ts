import { useCallback, useEffect, useState } from "react";
import type { AcpSessionSnapshot } from "../../../shared/acp";
import { api, errorMessage } from "../api";
import { subscribeAcpSnapshot } from "../lib/acpSnapshotSubscription";

export interface AcpPanes {
	snapshot: (sessionId: string) => AcpSessionSnapshot | null;
	error: (sessionId: string) => string | null;
	dismissError: (sessionId: string) => void;
	/** Run an action on one pane's session; a failure shows in that pane. */
	run: (sessionId: string, action: () => Promise<unknown>) => void;
}

/**
 * The external-agent conversations shown in split panes beside the selected one.
 *
 * Unlike NekoLocal's, an ACP session takes every action by its own id, so a
 * pane needs no selection to act: it only has to keep its snapshot current,
 * which main pushes for every open session anyway.
 */
export function useAcpPanes(sessionIds: readonly string[]): AcpPanes {
	const [snapshots, setSnapshots] = useState<ReadonlyMap<string, AcpSessionSnapshot>>(new Map());
	const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
	const key = [...sessionIds].sort().join("\n");

	useEffect(() => {
		const ids = new Set(key ? key.split("\n") : []);
		setSnapshots((current) =>
			[...current.keys()].every((id) => ids.has(id))
				? current
				: new Map([...current].filter(([id]) => ids.has(id))),
		);
		if (ids.size === 0) return;
		// Asking for the snapshot also marks the session as on screen, so main
		// closes it last when it trims idle sessions.
		const unsubscribes = [...ids].map((id) => subscribeAcpSnapshot(api, id, (next) => {
			if (next) setSnapshots((current) => new Map(current).set(id, next));
		}));
		return () => {
			for (const unsubscribe of unsubscribes) unsubscribe();
		};
	}, [key]);

	const dismissError = useCallback((sessionId: string) => {
		setErrors((current) => {
			if (!(sessionId in current)) return current;
			const { [sessionId]: _dropped, ...rest } = current;
			return rest;
		});
	}, []);

	const run = useCallback(
		(sessionId: string, action: () => Promise<unknown>) => {
			dismissError(sessionId);
			action().catch((cause: unknown) =>
				setErrors((current) => ({ ...current, [sessionId]: errorMessage(cause) })),
			);
		},
		[dismissError],
	);

	return {
		snapshot: (sessionId) => snapshots.get(sessionId) ?? null,
		error: (sessionId) => errors[sessionId] ?? null,
		dismissError,
		run,
	};
}
