import type { FusionConfig } from "../shared/fusion";
import type { FusionUpgradeRequest } from "./fusion-report-tool";

/** Conservative classifier: explicit risk evidence, not tool failure counts or task size. */
export function fusionRouteAtCompaction(config: FusionConfig, currentModelKey: string,
	request: FusionUpgradeRequest | undefined, changesInTask: number): "lead" | "sidekick" | undefined {
	if (!config.adaptiveRouting || changesInTask > 0 || config.leadModelKey === config.sidekickModelKey) return;
	if (request?.reason.trim() && request.evidence.trim() && currentModelKey === config.sidekickModelKey) return "lead";
	// A later routine task may return to the cheap model, but never discard a warm prefix just to downgrade.
	if (!request && currentModelKey === config.leadModelKey) return "sidekick";
}
