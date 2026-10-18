import { useCallback, useSyncExternalStore } from "react";

const getServerSnapshot = () => false;

/** Subscribe to a browser media preference, including changes while mounted. */
export function useMediaQuery(query: string): boolean {
	const subscribe = useCallback((callback: () => void) => {
		const media = window.matchMedia(query);
		media.addEventListener("change", callback);
		return () => media.removeEventListener("change", callback);
	}, [query]);
	const getSnapshot = () => typeof window !== "undefined" && window.matchMedia(query).matches;
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
