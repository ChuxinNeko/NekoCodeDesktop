import { useId, useState } from "react";
import type { TurnUsage } from "../../../../shared/agent";
import { formatCost, formatDuration, formatPercent, formatRate, formatTokens, usageStats } from "../../../../shared/usage";
import { useTranslation } from "../../i18n";
import { GaugeIcon } from "../../lib/icons";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { cn } from "../../lib/utils";

function ModelUsageGrid({ usage, provider, model, role }: {
	usage?: TurnUsage;
	provider: string;
	model: string;
	role?: "lead" | "sidekick" | "fastContext";
}) {
	const { t } = useTranslation();
	const stats = usage ? usageStats(usage) : undefined;
	const tokens = (value?: number) => value === undefined ? "—" : formatTokens(value);
	const metrics = [
		{ key: "total", label: t("usage.total"), value: tokens(usage?.totalTokens) },
		{ key: "input", label: t("usage.input"), value: tokens(usage?.input) },
		{ key: "output", label: t("usage.output"), value: tokens(usage?.output),
			detail: usage?.reasoning !== undefined ? `${t("usage.reasoning")} ${formatTokens(usage.reasoning)}` : undefined },
		{ key: "cacheRead", label: t("usage.cacheRead"), value: tokens(usage?.cacheRead) },
		{ key: "cacheWrite", label: t("usage.cacheWrite"), value: tokens(usage?.cacheWrite) },
		{ key: "cacheHitRate", label: t("usage.cacheHitRate"),
			value: stats?.cacheHitRate != null ? formatPercent(stats.cacheHitRate) : "—" },
		{ key: "calls", label: t("usage.calls"), value: tokens(usage?.calls) },
		{ key: "speed", label: t("usage.speed"),
			value: stats?.tokensPerSecond != null ? formatRate(stats.tokensPerSecond) : "—" },
		{ key: "cost", label: t("usage.cost"),
			value: usage?.costUsd !== undefined ? formatCost(usage.costUsd) : "—" },
	];
	const roleLabel = role === "fastContext" ? "Fast Context" : role ? t(role === "lead" ? "fusion.lead" : "fusion.sidekick") : t("usage.model");
	const badge = role === "lead" ? "Lead" : role === "sidekick" ? "SideKick" : role === "fastContext" ? "Fast Context" : null;
	return (
		<section className="min-w-0 space-y-2" aria-label={roleLabel}>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				{badge ? <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{badge}</span> : null}
				<span className="min-w-0 break-all text-xs font-medium text-foreground">{provider ? `${provider}/${model}` : model}</span>
			</div>
			{usage?.responseModel ? <p className="break-all text-xs text-muted-foreground">{t("usage.servedBy")}: {usage.responseModel}</p> : null}
			{!usage ? <p className="text-xs text-muted-foreground">{t("usage.unrecorded")}</p> : null}
			<dl className="grid grid-cols-3 gap-1.5">
				{metrics.map((metric) => (
					<div key={metric.key} className="min-w-0 rounded-lg border border-border/50 bg-muted/30 px-2.5 py-2.5">
						<dt className="text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-muted-foreground">{metric.label}</dt>
						<dd className={cn("mt-1 break-all font-mono text-sm font-medium tabular-nums", metric.key === "total" ? "text-primary" : "text-foreground")}>
							{metric.value}
							{metric.detail ? <span className="mt-1 block font-sans text-[10px] font-normal text-muted-foreground">{metric.detail}</span> : null}
						</dd>
					</div>
				))}
			</dl>
			{stats?.durationSeconds != null || stats?.modelSeconds != null ? (
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{stats.durationSeconds != null ? <span>{t("usage.duration")}: {formatDuration(stats.durationSeconds)}</span> : null}
					{stats.modelSeconds != null ? <span>{t("usage.modelTime")}: {formatDuration(stats.modelSeconds)}</span> : null}
				</div>
			) : null}
		</section>
	);
}

export function UsageDetails({ usage }: { usage: TurnUsage }) {
	const { t } = useTranslation();
	const breakdown = usage.fusion || usage.fastContext;
	return (
		<div className="w-full max-w-xl space-y-4 rounded-xl border border-border/60 bg-background/60 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs">
				<span className="font-medium text-foreground">{usage.fusion ? `Fusion · ${t("usage.title")}` : t("usage.title")}</span>
				{breakdown ? <span className="font-mono tabular-nums text-muted-foreground">{formatTokens(usage.totalTokens)} tokens</span> : null}
			</div>
			{breakdown ? (
				<>
					{usage.fusion ? (
						<ModelUsageGrid role="lead" usage={usage.fusion.lead} provider={usage.fusion.lead.provider} model={usage.fusion.lead.model} />
					) : usage.fastContext ? (
						<ModelUsageGrid usage={usage.fastContext.primary} provider={usage.fastContext.primary.provider} model={usage.fastContext.primary.model} />
					) : null}
					{usage.fusion ? (
						<>
							<div className="border-t border-border/60" />
							<ModelUsageGrid role="sidekick" {...usage.fusion.sidekick} />
						</>
					) : null}
					{usage.fastContext ? (
						<>
							<div className="border-t border-border/60" />
							<ModelUsageGrid role="fastContext" {...usage.fastContext.search} />
						</>
					) : null}
				</>
			) : <ModelUsageGrid usage={usage} provider={usage.provider} model={usage.model} />}
		</div>
	);
}

/** Keep reference metrics behind the existing usage button at the end of a turn. */
export function UsagePanel({ usage }: { usage: TurnUsage }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const id = useId();
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<button type="button" aria-expanded={open} aria-controls={open ? id : undefined}
				aria-label={t("usage.title")} title={t("usage.title")}
				onClick={() => setOpen((value) => !value)}
				className={cn("inline-flex w-fit items-center rounded p-0.5 hover:text-foreground", MUTED_LABEL_TEXT_CLASS_NAME)}>
				<GaugeIcon className="size-3.5" />
			</button>
			{open ? <div id={id}><UsageDetails usage={usage} /></div> : null}
		</div>
	);
}
