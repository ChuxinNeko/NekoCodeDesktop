export interface ModelIdentity {
	provider: string;
	id: string;
}

export type ReloadDecision =
	| { kind: "set"; model: ModelIdentity }
	| { kind: "removed" }
	| { kind: "none" };

/**
 * Decide what the active session's model should be after custom providers are
 * re-registered:
 * - A custom model that still exists is re-set so edited credentials take effect.
 * - A removed custom model falls back to the first available custom model, or
 *   is reported as removed when none remains.
 * - A missing/placeholder model auto-selects the first custom model.
 * - A healthy built-in model is left alone.
 */
export function decideModelAfterReload(opts: {
	current: ModelIdentity | null;
	isRegistered: (provider: string, id: string) => boolean;
	firstCustom: ModelIdentity | null;
}): ReloadDecision {
	const { current, isRegistered, firstCustom } = opts;
	if (current && current.provider.startsWith("nekocode-")) {
		if (isRegistered(current.provider, current.id)) {
			return { kind: "set", model: current };
		}
		if (firstCustom) return { kind: "set", model: firstCustom };
		return { kind: "removed" };
	}
	if (!current || current.provider === "unknown") {
		return firstCustom ? { kind: "set", model: firstCustom } : { kind: "none" };
	}
	return { kind: "none" };
}
