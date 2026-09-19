import type { AppRelease, UpdateCheckResult } from "../../../shared/updates";

export interface UpdateNotice {
	currentVersion: string;
	release: AppRelease;
}

/** Keep startup responsive and cancel stale results on unmount/StrictMode replay. */
export function scheduleStartupUpdate(
	check: () => Promise<UpdateCheckResult | null>,
	notify: (notice: UpdateNotice) => void,
	delayMs = 3000,
): () => void {
	let active = true;
	const timer = setTimeout(() => {
		void (async () => {
			try {
				const result = await check();
				if (active && result?.status === "available")
					notify({ currentVersion: result.currentVersion, release: result.release });
			} catch {
				// Background failures are silent; the About page offers a manual retry.
			}
		})();
	}, delayMs);
	return () => { active = false; clearTimeout(timer); };
}
