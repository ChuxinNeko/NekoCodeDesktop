import { useEffect, useState } from "react";

/**
 * Ticks once a second while `active` so elapsed-time labels stay current.
 *
 * Shared rather than per-component so every running thing in the chat column —
 * a reasoning block, a work group, a background worker — counts on the same
 * cadence instead of drifting a second apart from its neighbours.
 */
export function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [active]);
	return now;
}

export function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

/** Whole seconds between two epoch stamps, never negative. */
export function elapsedSeconds(startedAt: number, endedAt: number): number {
	return Math.max(0, Math.floor((endedAt - startedAt) / 1000));
}
