import {
	cacheHitRate,
	totalTokens,
	type TokenUsageReport,
} from "../shared/tokenStats";

/**
 * The token ledger as a spreadsheet.
 *
 * One row per (day × provider × model × workspace) — the same grain the panel
 * charts — so a total in the app can be reconciled against a provider's own
 * invoice without anyone having to re-derive it from the transcripts.
 */

/**
 * RFC 4180 quoting, applied to everything.
 *
 * Model ids carry slashes, workspace paths carry backslashes and spaces, and a
 * session title carries whatever the user typed — quoting only the fields that
 * look dangerous is how a stray comma silently shifts every later column.
 */
function cell(value: string | number): string {
	const text = typeof value === "number" ? String(value) : value;
	return `"${text.replace(/"/g, '""')}"`;
}

function row(values: (string | number)[]): string {
	return values.map(cell).join(",");
}

const HEADER = [
	"date",
	"provider",
	"provider_name",
	"model",
	"workspace",
	"calls",
	"input_tokens",
	"output_tokens",
	"reasoning_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"total_tokens",
	"cache_hit_rate",
	"cost_usd",
	"estimated_cost_usd",
	"unpriced_calls",
];

export function tokenUsageCsv(report: TokenUsageReport): string {
	const lines = [row(HEADER)];
	for (const bucket of report.buckets) {
		const hitRate = cacheHitRate(bucket);
		lines.push(
			row([
				bucket.date,
				bucket.provider,
				report.providerLabels[bucket.provider] ?? bucket.provider,
				bucket.model,
				bucket.cwd,
				bucket.calls,
				bucket.input,
				bucket.output,
				bucket.reasoning,
				bucket.cacheRead,
				bucket.cacheWrite,
				totalTokens(bucket),
				hitRate === null ? "" : hitRate.toFixed(4),
				bucket.costUsd.toFixed(6),
				bucket.estimatedCostUsd.toFixed(6),
				bucket.unpricedCalls,
			]),
		);
	}
	// A trailing newline: without one the last row is a partial line, and some
	// importers drop it.
	return `${lines.join("\n")}\n`;
}
