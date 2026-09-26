import { useCallback, useEffect, useState } from "react";
import type {
	OAuthProviderId,
	OAuthUsageMetric,
	OAuthUsageSnapshot,
	OAuthUsageWindow,
} from "../../../../shared/settings";
import { api, errorMessage } from "../../api";
import { useTranslation, type Language } from "../../i18n";
import { RefreshCwIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "2h 13m" / "2 小时 13 分" until a reset close enough to count down to. */
export function formatResetIn(ms: number, language: Language): string {
	const minutes = Math.max(1, Math.round(ms / MINUTE));
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (language === "zh-CN") {
		if (hours === 0) return `${minutes} 分钟`;
		return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
	}
	if (hours === 0) return `${minutes}m`;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatMetric(metric: OAuthUsageMetric, language: Language): string {
	if (metric.format === "currency") {
		return new Intl.NumberFormat(language, {
			style: "currency",
			currency: metric.currency ?? "USD",
			maximumFractionDigits: 2,
		}).format(metric.value);
	}
	return new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(metric.value);
}

/** What is left, as a color: calm until it is close to running out. */
function barTone(remainingPercent: number): string {
	if (remainingPercent <= 10) return "bg-[var(--destructive)]";
	if (remainingPercent <= 30) return "bg-[var(--warning)]";
	return "bg-foreground/70";
}

function UsageWindow({ window, now }: { window: OAuthUsageWindow; now: number }) {
	const { t, language } = useTranslation();
	const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
	// Providers report what is used; what matters when choosing a model is what is left.
	const remainingPercent = window.usedPercent === undefined ? undefined : 100 - window.usedPercent;
	const figures = window.unlimited
		? t("oauth.usage.unlimited")
		: window.used !== undefined && window.limit !== undefined
			? t("oauth.usage.count", {
					remaining: number.format(Math.max(0, window.limit - window.used)),
					limit: number.format(window.limit),
				})
			: remainingPercent !== undefined
				? t("oauth.usage.remaining", { percent: Math.round(remainingPercent) })
				: "";
	const reset =
		window.resetsAt === undefined
			? ""
			: window.resetsAt - now < 48 * HOUR
				? t("oauth.usage.resetsIn", { time: formatResetIn(window.resetsAt - now, language) })
				: t("oauth.usage.resetsOn", {
						date: new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(window.resetsAt),
					});
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-baseline gap-2 text-[length:var(--app-font-size-ui-xs,10px)]">
				<span className="min-w-0 truncate font-medium text-foreground">{window.label}</span>
				<span className="shrink-0 tabular-nums text-muted-foreground">{figures}</span>
				<div className="flex-1" />
				{reset ? <span className="shrink-0 text-muted-foreground">{reset}</span> : null}
			</div>
			{window.unlimited || remainingPercent === undefined ? null : (
				<span
					role="meter"
					aria-label={window.label}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(remainingPercent)}
					className="block h-1.5 w-full overflow-hidden rounded-full bg-[var(--usage-heat-0)]"
				>
					<span
						className={cn("block h-full rounded-full", barTone(remainingPercent))}
						style={{ width: `${Math.max(remainingPercent, remainingPercent > 0 ? 2 : 0)}%` }}
					/>
				</span>
			)}
		</div>
	);
}

/**
 * What a signed-in subscription has left, under its account row.
 *
 * Read when the row appears and again on demand; the main process keeps each
 * answer for a minute, so reopening settings does not ask the provider again.
 * A provider that cannot be asked says so in one line instead of an empty box.
 */
export function OAuthUsage({ provider }: { provider: OAuthProviderId }) {
	const { t, language } = useTranslation();
	const [usage, setUsage] = useState<OAuthUsageSnapshot | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(
		(force: boolean) => {
			setLoading(true);
			setError(null);
			api
				.oauthUsage(provider, force)
				.then(setUsage)
				.catch((cause: unknown) => setError(errorMessage(cause)))
				.finally(() => setLoading(false));
		},
		[provider],
	);

	useEffect(() => load(false), [load]);

	const now = Date.now();
	const message = error ?? (usage && usage.status !== "ok" ? usage.message : usage?.message);
	return (
		<div className="mt-1 flex flex-col gap-2 rounded-lg bg-[var(--color-background-elevated-secondary)] px-2.5 py-2">
			<div className="flex items-center gap-2 text-[length:var(--app-font-size-ui-xs,10px)]">
				<span className="font-medium text-muted-foreground">{t("oauth.usage.title")}</span>
				{usage?.plan ? (
					<span className="rounded-full border border-border/60 px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
						{usage.plan}
					</span>
				) : null}
				<div className="flex-1" />
				{usage && !loading ? (
					<span className="text-muted-foreground/80">
						{t("oauth.usage.updated", {
							time: new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(usage.fetchedAt),
						})}
					</span>
				) : null}
				<Button
					onClick={() => load(true)}
					size="icon-xs"
					variant="ghost"
					disabled={loading}
					title={t("oauth.usage.refresh")}
					aria-label={t("oauth.usage.refresh")}
				>
					{loading ? <Spinner className="size-3" /> : <RefreshCwIcon className="size-3" />}
				</Button>
			</div>
			{!usage && loading ? (
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("oauth.usage.loading")}</span>
			) : null}
			{usage?.windows.map((window) => <UsageWindow key={window.label} window={window} now={now} />)}
			{usage && usage.metrics.length > 0 ? (
				<dl className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--app-font-size-ui-xs,10px)]">
					{usage.metrics.map((metric) => (
						<div key={metric.label} className="flex gap-1">
							<dt className="text-muted-foreground">{metric.label}</dt>
							<dd className="font-medium tabular-nums text-foreground">{formatMetric(metric, language)}</dd>
						</div>
					))}
				</dl>
			) : null}
			{message ? (
				<span
					className={cn(
						"text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed",
						error || usage?.status === "error" ? "text-[var(--warning)]" : "text-muted-foreground",
					)}
				>
					{message}
				</span>
			) : null}
		</div>
	);
}
