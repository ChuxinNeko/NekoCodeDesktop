/**
 * A sliding-window limiter, held in memory.
 *
 * In memory means per instance: two processes behind a load balancer each
 * allow the full budget. That is a deliberate trade for now — the limits that
 * actually gate abuse (code attempts, resend cooldown) live in MongoDB on the
 * verification document and are therefore shared. This one is the cheap outer
 * layer that keeps a single instance from being flooded.
 *
 * Move it to Mongo or Redis before running more than one instance.
 */
export class RateLimiter {
	private readonly hits = new Map<string, number[]>();
	private lastSweep = Date.now();

	constructor(
		private readonly limit: number,
		private readonly windowMs: number,
	) {}

	/** True when the caller is within budget; the call itself counts. */
	take(key: string): boolean {
		const now = Date.now();
		this.sweep(now);
		const recent = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
		if (recent.length >= this.limit) {
			// Written back so the window keeps sliding rather than resetting.
			this.hits.set(key, recent);
			return false;
		}
		recent.push(now);
		this.hits.set(key, recent);
		return true;
	}

	/** Seconds until the caller gets another go, for a Retry-After header. */
	retryAfter(key: string): number {
		const oldest = (this.hits.get(key) ?? [])[0];
		if (oldest === undefined) return 0;
		return Math.max(1, Math.ceil((oldest + this.windowMs - Date.now()) / 1000));
	}

	/**
	 * Drop expired keys.
	 *
	 * Swept on use rather than on a timer: an idle server should not hold a
	 * wakeup, and a busy one sweeps often enough on its own. Without this the
	 * map is a slow leak keyed by every IP that ever connected.
	 */
	private sweep(now: number): void {
		if (now - this.lastSweep < this.windowMs) return;
		this.lastSweep = now;
		for (const [key, times] of this.hits) {
			const recent = times.filter((at) => at > now - this.windowMs);
			if (recent.length) this.hits.set(key, recent);
			else this.hits.delete(key);
		}
	}
}

/**
 * Who is asking, as well as this can be known.
 *
 * `x-forwarded-for` is only trustworthy behind a proxy that sets it, which is
 * the deployment this is written for; the leftmost entry is the client as that
 * proxy saw it. Direct exposure to the internet would let a caller forge this,
 * so put it behind nginx or a tunnel.
 */
export function clientIp(headers: Record<string, string | undefined>): string {
	const forwarded = headers["x-forwarded-for"];
	if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
	return headers["x-real-ip"]?.trim() || "unknown";
}
