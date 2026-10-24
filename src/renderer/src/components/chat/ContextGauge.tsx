import { Popover } from "@base-ui/react/popover";
import type { ContextCategory, ContextUsage } from "../../../../shared/agent";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";

const WARN_AT = 0.75;
const DANGER_AT = 0.9;
const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const CATEGORIES: { id: ContextCategory; color: string }[] = [
	{ id: "system", color: "#737373" },
	{ id: "tools", color: "#805ad5" },
	{ id: "rules", color: "#00854a" },
	{ id: "skills", color: "#b77900" },
	{ id: "mcp", color: "#a00080" },
	{ id: "subagents", color: "#3979ce" },
	{ id: "conversation", color: "#d63020" },
];

function tokens(value: number): string {
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
	if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
	return String(Math.round(value));
}

function usageRatio(context: ContextUsage): number {
	return Number.isFinite(context.used) && Number.isFinite(context.window) && context.window > 0
		? Math.max(context.used / context.window, 0) : 0;
}

/** Shared by native and ACP sessions. Missing categories are unknown, never zero. */
export function ContextUsageReport({ context }: { context: ContextUsage }) {
	const { t, language } = useTranslation();
	const ratio = usageRatio(context);
	const percent = Math.round(ratio * 100);
	const rows = CATEGORIES.map((category) => {
		const value = context.breakdown?.[category.id];
		return { ...category, value: typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined };
	});
	const total = rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
	const unknown = Math.max(0, context.used - total);
	const scale = Math.max(context.window, context.used, total, 1);
	const exact = (value: number) => new Intl.NumberFormat(language).format(value);
	return <div className="p-4" data-slot="context-usage-report">
		<div className="mb-4 flex items-center justify-between gap-3">
			<Popover.Title className="text-[13px] font-medium text-foreground">{t("context.reportTitle")}</Popover.Title>
			<div className="flex items-center gap-2">
				{context.source === "acp" ? <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">ACP</span> : null}
				<Popover.Close aria-label={t("context.closeReport")} className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring">
					<svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true"><path d="M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
				</Popover.Close>
			</div>
		</div>
		<div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[12px] text-muted-foreground tabular-nums">
			<span>{t("context.full", { percent })}</span>
			<span title={`${exact(context.used)} / ${exact(context.window)} Tokens`}>{tokens(context.used)} / {tokens(context.window)} Tokens</span>
		</div>
		<div role="progressbar" aria-label={t("context.title")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(percent, 100)} aria-valuetext={t("context.full", { percent })}
			className="mb-4 flex h-1.5 overflow-hidden rounded-full bg-foreground/10">
			{rows.filter((row) => row.value !== undefined && row.value > 0).map((row) => <span key={row.id} className="h-full shrink-0 rounded-[1px]" style={{ width: `${row.value! / scale * 100}%`, backgroundColor: row.color }} />)}
			{unknown > 0 ? <span className="h-full shrink-0 rounded-[1px] bg-foreground/40" style={{ width: `${unknown / scale * 100}%` }} /> : null}
		</div>
		<dl className="space-y-3">
			{rows.map((row) => <div key={row.id} className="flex items-center justify-between gap-6 text-[12px]">
				<dt className="flex min-w-0 items-center gap-2.5"><span aria-hidden="true" className="size-3 shrink-0 rounded-[3px]" style={{ backgroundColor: row.color }} /><span>{t(`context.category.${row.id}`)}</span></dt>
				<dd className="shrink-0 tabular-nums text-muted-foreground" title={row.value === undefined ? t("context.notReported") : exact(row.value)}>
					{row.value === undefined ? "—" : `${context.breakdownEstimated && row.value > 0 ? "~" : ""}${tokens(row.value)}`}
				</dd>
			</div>)}
			{unknown > 0 ? <div className="flex items-center justify-between gap-6 border-t border-border/60 pt-3 text-[12px] text-muted-foreground"><dt>{t("context.unclassified")}</dt><dd className="tabular-nums">{tokens(unknown)}</dd></div> : null}
		</dl>
		<p className="mt-4 border-t border-border/60 pt-3 text-[11px] leading-relaxed text-muted-foreground">
			{context.breakdownSource === "codex-rollout" ? t("context.codexEstimatedHint") : context.breakdownEstimated ? t("context.estimatedHint") : context.source === "acp" ? t("context.acpHint") : t("context.noBreakdownHint")}
		</p>
		{ratio >= WARN_AT ? <p className={cn("mt-2 text-[11px] leading-relaxed", ratio >= DANGER_AT ? "text-destructive" : "text-[var(--warning)]")}>{t("context.hintNearFull")}</p> : null}
	</div>;
}

/** Hover or click reveals the report beside either composer. */
export function ContextGauge({ context }: { context: ContextUsage }) {
	const { t } = useTranslation();
	const ratio = Math.min(usageRatio(context), 1);
	const percent = Math.round(usageRatio(context) * 100);
	const stroke = ratio >= DANGER_AT ? "var(--destructive)" : ratio >= WARN_AT ? "var(--warning)" : "var(--color-text-accent)";
	return <Popover.Root>
		<Popover.Trigger openOnHover delay={180} closeDelay={180} aria-label={t("context.label", { percent: String(percent) })}
			className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)]/60 data-[popup-open]:bg-[var(--color-background-elevated-secondary)]">
			<svg aria-hidden="true" viewBox="0 0 18 18" className="size-4.5 -rotate-90">
				<circle cx="9" cy="9" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground/25" />
				<circle cx="9" cy="9" r={RADIUS} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - ratio)} className="transition-[stroke-dashoffset] duration-300" />
			</svg>
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Positioner side="top" align="end" sideOffset={10} collisionPadding={12} collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "start" }} className="z-[80]">
				<Popover.Popup initialFocus={false} aria-label={t("context.reportTitle")} className="max-h-[var(--available-height)] w-[min(26rem,var(--available-width))] overflow-y-auto overscroll-contain rounded-xl border border-border/70 bg-popover/70 text-popover-foreground shadow-xl backdrop-blur-2xl backdrop-saturate-150 outline-none">
					<ContextUsageReport context={context} />
				</Popover.Popup>
			</Popover.Positioner>
		</Popover.Portal>
	</Popover.Root>;
}
