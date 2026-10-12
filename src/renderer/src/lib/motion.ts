import { useEffect, useState, useSyncExternalStore } from "react";

export const DISCLOSURE_DURATION_MS = 180;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
function subscribe(listener: () => void) {
	const query = window.matchMedia(REDUCED_MOTION_QUERY);
	query.addEventListener("change", listener);
	return () => query.removeEventListener("change", listener);
}
export function useReducedMotion(): boolean {
	return useSyncExternalStore(subscribe, () => window.matchMedia(REDUCED_MOTION_QUERY).matches, () => false);
}

/** Give the live work group time to close before replacing it with saved rows. */
export function useRunSettlement(running: boolean, sessionId: string | undefined): boolean {
	const reduced = useReducedMotion();
	const [previous, setPrevious] = useState({ running, sessionId });
	const settling = !reduced && !running && previous.running && previous.sessionId === sessionId;
	useEffect(() => {
		if (running || reduced || previous.sessionId !== sessionId) {
			setPrevious({ running, sessionId });
			return;
		}
		if (!previous.running) return;
		const timer = window.setTimeout(() => setPrevious({ running: false, sessionId }), DISCLOSURE_DURATION_MS + 40);
		return () => window.clearTimeout(timer);
	}, [running, sessionId, reduced, previous.running, previous.sessionId]);
	return settling;
}
