import { useEffect, useState } from "react";

/**
 * A clock that re-renders on an interval, so relative timestamps ("5m", "3h")
 * age on their own instead of freezing at whatever they said on mount.
 */
export function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}
