import { useCallback, useEffect, useMemo, useState } from "react";
import {
	breakdown,
	buildCalendar,
	cacheHitRate,
	dailySeries,
	dayKey,
	filterBuckets,
	formatCompactTokens,
	formatSignedPercent,
	hourlyProfile,
	percentChange,
	previousWindow,
	promptTokens,
	rangeWindow,
	shiftDay,
	sumCounts,
	tokenStreaks,
	totalTokens,
	type TokenBreakdownRow,
	type TokenRangeId,
	type TokenUsageReport,
} from "../../../../shared/tokenStats";
import { formatCost, formatPercent, formatTokens } from "../../../../shared/usage";
import { projectLabel } from "../../../../shared/paths";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import { DownloadIcon, RefreshCwIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
	ActivityClock,
	CompositionBar,
	ContributionCalendar,
	ShareBar,
} from "./TokenUsageCharts";

/**
 * What the user has spent, over every session the app has ever run.
 *
 * The numbers come off the transcripts rather than off a counter this panel
 * keeps, so they are the same numbers the per-turn usage panel shows — summed,
 * not re-measured — and they survive reinstalling the app.
 */

const RANGES: { id: TokenRangeId; labelKey: TranslationKey }[] = [
	{ id: "7d", labelKey: "tokens.range.7d" },
	{ id: "30d", labelKey: "tokens.range.30d" },
	{ id: "90d", labelKey: "tokens.range.90d" },
	{ id: "365d", labelKey: "tokens.range.365d" },
	{ id: "all", labelKey: "tokens.range.all" },
];

const DIMENSIONS: { id: Dimension; labelKey: TranslationKey }[] = [
	{ id: "model", labelKey: "tokens.byModel" },
	{ id: "provider", labelKey: "tokens.byProvider" },
	{ id: "workspace", labelKey: "tokens.byWorkspace" },
];

type Dimension = "model" | "provider" | "workspace";
type CalendarPeriod = "rolling" | number;

const CARD_CLASS =
	"flex flex-col gap-3 rounded-xl border border-[color:var(--app-surface-divider)] bg-foreground/2 p-3.5";

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
	return <section className={cn(CARD_CLASS, className)}>{children}</section>;
}

function CardTitle({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="flex min-w-0 flex-col">
				<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">{title}</span>
				{hint ? (
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{hint}
					</span>
				) : null}
			</div>
			{action ? <div className="shrink-0">{action}</div> : null}
		</div>
	);
}

/** Label · value · optional footnote. The tile contract, one row of the grid. */
function Tile({
	label,
	value,
	footnote,
	children,
}: {
	label: string;
	value: string;
	footnote?: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1 rounded-lg border border-[color:var(--app-surface-divider)] bg-foreground/2 p-3">
			<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
				{label}
			</span>
			<span className="text-[17px] font-semibold leading-tight">{value}</span>
			{footnote ? (
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{footnote}
				</span>
			) : null}
			{children}
		</div>
	);
}

/** One row of the breakdown table: name, share bar, tokens, calls. */
function BreakdownRow({ row, detail }: { row: TokenBreakdownRow; detail: string }) {
	return (
		<div className="flex flex-col gap-1 py-1.5">
			<div className="flex items-baseline justify-between gap-3">
				<span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)]" title={row.label}>
					{row.label}
				</span>
				<span className="shrink-0 tabular-nums text-[length:var(--app-font-size-ui,12px)]">
					{formatTokens(row.total)}
				</span>
			</div>
			<ShareBar share={row.share} />
			<span className="text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground">
				{detail}
			</span>
		</div>
	);
}

/**
 * The dashboard proper: everything derived from one report.
 *
 * Kept apart from the panel that fetches it so the derivation and the layout
 * can be rendered from a fixture, and so the period controls the reader actually
 * touches live next to the numbers they change rather than in the loader.
 */
export function TokenUsageDashboard({
	report,
	actions,
}: {
	report: TokenUsageReport;
	actions?: React.ReactNode;
}) {
	const { language, t } = useTranslation();
	const locale = language === "zh-CN" ? "zh-CN" : "en-US";

	const [range, setRange] = useState<TokenRangeId>("30d");
	const [period, setPeriod] = useState<CalendarPeriod>("rolling");
	const [dimension, setDimension] = useState<Dimension>("model");
	const [selectedDay, setSelectedDay] = useState<string | null>(null);

	const view = useMemo(() => {
		const today = dayKey(Date.now());
		const window = rangeWindow(range, today);
		const buckets = filterBuckets(report.buckets, window);
		const totals = sumCounts(buckets);
		const previous = previousWindow(range, today);
		const previousTotals = previous
			? sumCounts(filterBuckets(report.buckets, previous))
			: null;
		const days = dailySeries(buckets);

		const thisYear = new Date().getFullYear();
		const years = [...new Set(report.buckets.map((bucket) => Number(bucket.date.slice(0, 4))))]
			.filter((year) => Number.isFinite(year))
			.sort((a, b) => b - a);
		const calendarWindow =
			period === "rolling"
				? { start: shiftDay(today, -364), end: today }
				: {
						start: `${period}-01-01`,
						// A year still running stops at today: drawing empty squares for
						// days that have not happened reads as idleness.
						end: period === thisYear ? today : `${period}-12-31`,
					};
		const calendar = buildCalendar(
			dailySeries(filterBuckets(report.buckets, calendarWindow)),
			{ ...calendarWindow, weekStartsOn: language === "zh-CN" ? 1 : 0 },
		);

		const providerLabel = (id: string): string =>
			report.providerLabels[id] ?? (id || t("tokens.unknownProvider"));

		const rows: Record<Dimension, TokenBreakdownRow[]> = {
			model: breakdown(buckets, (bucket) => ({
				key: `${bucket.provider}/${bucket.model}`,
				label: bucket.model
					? `${providerLabel(bucket.provider)} / ${bucket.model}`
					: t("tokens.unknownModel"),
			})),
			provider: breakdown(buckets, (bucket) => ({
				key: bucket.provider,
				label: providerLabel(bucket.provider),
			})),
			workspace: breakdown(buckets, (bucket) => ({
				key: bucket.cwd,
				label: bucket.cwd
					? projectLabel(bucket.cwd, api.homeDir)
					: t("tokens.unknownWorkspace"),
			})),
		};

		const sessions = report.sessions
			.filter((session) => {
				const date = dayKey(session.updatedAt);
				return window.start === null ? true : date >= window.start && date <= window.end;
			})
			.map((session) => ({ session, total: totalTokens(session) }))
			.sort((a, b) => b.total - a.total)
			.slice(0, 8);

		const dayBuckets = selectedDay
			? report.buckets.filter((bucket) => bucket.date === selectedDay)
			: [];

		return {
			today,
			window,
			totals,
			previousTotals,
			days,
			calendar,
			calendarWindow,
			years,
			rows,
			sessions,
			streaks: tokenStreaks(dailySeries(report.buckets), today),
			clock: hourlyProfile(report.hours, window),
			providerLabel,
			dayDetail: selectedDay
				? {
						date: selectedDay,
						totals: sumCounts(dayBuckets),
						models: breakdown(dayBuckets, (bucket) => ({
							key: `${bucket.provider}/${bucket.model}`,
							label: bucket.model || t("tokens.unknownModel"),
						})),
					}
				: null,
		};
	}, [report, range, period, selectedDay, language, t]);

	const { totals, previousTotals } = view;
	const total = totalTokens(totals);
	const prompt = promptTokens(totals);
	const hitRate = cacheHitRate(totals);
	const change = previousTotals ? percentChange(total, totalTokens(previousTotals)) : null;
	const activeDays = view.days.filter((day) => day.total > 0).length;
	const rows = view.rows[dimension];

	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-1 rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
					{RANGES.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => setRange(entry.id)}
							className={cn(
								"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
								range === entry.id
									? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{t(entry.labelKey)}
						</button>
					))}
				</div>
				{actions}
			</div>

			{total === 0 ? (
				<Card>
					<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{t("tokens.emptyRange")}
					</span>
				</Card>
			) : null}

			{/* The headline figure, with the split that produced it beside it. */}
			<Card>
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="flex flex-col gap-0.5">
						<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
							{t("tokens.total")}
						</span>
						<span className="text-[26px] font-semibold leading-none">
							{formatTokens(total)}
						</span>
						<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
							{change === null
								? t("tokens.noComparison")
								: t("tokens.vsPrevious", { value: formatSignedPercent(change) })}
						</span>
					</div>
					<div className="min-w-[16rem] flex-1">
						<CompositionBar
							parts={[
								{
									key: "input",
									label: t("tokens.input"),
									value: totals.input,
									color: "var(--usage-input)",
								},
								{
									key: "output",
									label: t("tokens.output"),
									value: totals.output,
									color: "var(--usage-output)",
								},
								{
									key: "cacheRead",
									label: t("tokens.cacheRead"),
									value: totals.cacheRead,
									color: "var(--usage-cache-read)",
								},
								{
									key: "cacheWrite",
									label: t("tokens.cacheWrite"),
									value: totals.cacheWrite,
									color: "var(--usage-cache-write)",
								},
							]}
						/>
					</div>
				</div>
			</Card>

			<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
				<Tile
					label={t("tokens.input")}
					value={formatTokens(totals.input)}
					footnote={t("tokens.shareOfPrompt", {
						value: prompt > 0 ? formatPercent(totals.input / prompt) : "—",
					})}
				/>
				<Tile
					label={t("tokens.output")}
					value={formatTokens(totals.output)}
					footnote={
						totals.reasoning > 0
							? t("tokens.ofWhichReasoning", { value: formatTokens(totals.reasoning) })
							: t("tokens.shareOfTotal", {
									value: total > 0 ? formatPercent(totals.output / total) : "—",
								})
					}
				/>
				<Tile
					label={t("tokens.cacheHitRate")}
					value={hitRate === null ? "—" : formatPercent(hitRate)}
					footnote={t("tokens.cacheHitRateHint")}
				>
					<span className="mt-0.5 block">
						<ShareBar share={hitRate ?? 0} />
					</span>
				</Tile>
				<Tile
					label={t("tokens.cacheRead")}
					value={formatTokens(totals.cacheRead)}
					footnote={t("tokens.cacheReadHint")}
				/>
				<Tile
					label={t("tokens.cacheWrite")}
					value={formatTokens(totals.cacheWrite)}
					footnote={t("tokens.cacheWriteHint")}
				/>
				<Tile
					label={t("tokens.cost")}
					value={formatCost(totals.costUsd)}
					footnote={t("tokens.costHint")}
				/>
			</div>

			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				<Tile label={t("tokens.calls")} value={formatTokens(totals.calls)} />
				<Tile
					label={t("tokens.avgPerCall")}
					value={totals.calls > 0 ? formatCompactTokens(total / totals.calls) : "—"}
				/>
				<Tile
					label={t("tokens.avgPerDay")}
					value={activeDays > 0 ? formatCompactTokens(total / activeDays) : "—"}
					footnote={t("tokens.activeDaysCount", { count: activeDays })}
				/>
				<Tile
					label={t("tokens.sessionsUsed")}
					value={formatTokens(view.sessions.length)}
					footnote={t("tokens.sessionsHint")}
				/>
			</div>

			{/* Calendar ---------------------------------------------------------- */}
			<Card>
				<CardTitle
					title={t("tokens.calendar")}
					hint={t("tokens.calendarSummary", {
						active: view.calendar.activeDays,
						days: view.calendar.days,
						tokens: formatCompactTokens(view.calendar.tokens),
					})}
					action={
						<div className="flex items-center gap-1">
							{[
								{ id: "rolling" as CalendarPeriod, label: t("tokens.rollingYear") },
								...view.years.map((year) => ({ id: year as CalendarPeriod, label: String(year) })),
							].map((entry) => (
								<button
									key={String(entry.id)}
									type="button"
									onClick={() => {
										setPeriod(entry.id);
										setSelectedDay(null);
									}}
									className={cn(
										"rounded-md px-2 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] transition-colors",
										period === entry.id
											? "bg-[var(--sidebar-selected)] text-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{entry.label}
								</button>
							))}
						</div>
					}
				/>
				<ContributionCalendar
					calendar={view.calendar}
					locale={locale}
					selected={selectedDay}
					onSelect={setSelectedDay}
				/>
				<div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-[color:var(--app-surface-divider)] pt-2.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					<span>
						{t("tokens.streakCurrent")}{" "}
						<span className="tabular-nums text-foreground">
							{t("tokens.dayCount", { count: view.streaks.current })}
						</span>
					</span>
					<span>
						{t("tokens.streakLongest")}{" "}
						<span className="tabular-nums text-foreground">
							{t("tokens.dayCount", { count: view.streaks.longest })}
						</span>
					</span>
					<span>
						{t("tokens.activeDays")}{" "}
						<span className="tabular-nums text-foreground">
							{t("tokens.dayCount", { count: view.streaks.activeDays })}
						</span>
					</span>
					{view.calendar.busiest ? (
						<span>
							{t("tokens.busiestDay")}{" "}
							<span className="tabular-nums text-foreground">
								{view.calendar.busiest.date} ·{" "}
								{formatCompactTokens(view.calendar.busiest.tokens)}
							</span>
						</span>
					) : null}
				</div>

				{view.dayDetail ? (
					<div className="flex flex-col gap-2 rounded-lg border border-[color:var(--app-surface-divider)] bg-foreground/2 p-3">
						<div className="flex items-center justify-between gap-3">
							<span className="text-[length:var(--app-font-size-ui,12px)] font-medium tabular-nums">
								{view.dayDetail.date}
							</span>
							<Button onClick={() => setSelectedDay(null)} size="sm" variant="ghost">
								{t("tokens.clearSelection")}
							</Button>
						</div>
						{view.dayDetail.totals.calls === 0 ? (
							<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{t("tokens.noActivity")}
							</span>
						) : (
							<>
								<span className="text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground">
									{t("tokens.dayDetailLine", {
										total: formatTokens(totalTokens(view.dayDetail.totals)),
										input: formatTokens(view.dayDetail.totals.input),
										output: formatTokens(view.dayDetail.totals.output),
										cacheRead: formatTokens(view.dayDetail.totals.cacheRead),
										calls: view.dayDetail.totals.calls,
									})}
								</span>
								<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
									{view.dayDetail.models.map((row) => (
										<BreakdownRow
											key={row.key}
											row={row}
											detail={t("tokens.rowDetail", {
												calls: row.calls,
												share: formatPercent(row.share),
											})}
										/>
									))}
								</div>
							</>
						)}
					</div>
				) : null}
			</Card>

			{/* Activity clock ----------------------------------------------------- */}
			<Card>
				<CardTitle title={t("tokens.activityClock")} hint={t("tokens.activityClockHint")} />
				<ActivityClock slots={view.clock} />
			</Card>

			{/* Breakdowns --------------------------------------------------------- */}
			<Card>
				<CardTitle
					title={t("tokens.breakdown")}
					hint={t("tokens.breakdownHint")}
					action={
						<div className="flex items-center gap-1 rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
							{DIMENSIONS.map((entry) => (
								<button
									key={entry.id}
									type="button"
									onClick={() => setDimension(entry.id)}
									className={cn(
										"rounded-md px-2 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] transition-colors",
										dimension === entry.id
											? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{t(entry.labelKey)}
								</button>
							))}
						</div>
					}
				/>
				{rows.length === 0 ? (
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{t("tokens.emptyRange")}
					</span>
				) : (
					<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
						{rows.map((row) => (
							<BreakdownRow
								key={row.key}
								row={row}
								detail={t("tokens.rowDetailFull", {
									calls: row.calls,
									share: formatPercent(row.share),
									input: formatCompactTokens(row.input),
									output: formatCompactTokens(row.output),
									cache: formatCompactTokens(row.cacheRead),
									cost: formatCost(row.costUsd),
								})}
							/>
						))}
					</div>
				)}
			</Card>

			{/* Top sessions -------------------------------------------------------- */}
			<Card>
				<CardTitle title={t("tokens.topSessions")} hint={t("tokens.topSessionsHint")} />
				{view.sessions.length === 0 ? (
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{t("tokens.emptyRange")}
					</span>
				) : (
					<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
						{view.sessions.map(({ session, total: sessionTotal }) => (
							<div key={session.file} className="flex items-baseline justify-between gap-3 py-1.5">
								<div className="flex min-w-0 flex-col">
									<span className="truncate text-[length:var(--app-font-size-ui,12px)]">
										{session.title}
										{session.kind === "automation" ? (
											<span className="ml-1.5 rounded px-1 py-px text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground ring-1 ring-[color:var(--app-surface-divider)]">
												{t("tokens.automation")}
											</span>
										) : null}
									</span>
									<span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
										{t("tokens.sessionMeta", {
											workspace: session.cwd
												? projectLabel(session.cwd, api.homeDir)
												: t("tokens.unknownWorkspace"),
											calls: session.calls,
											date: new Date(session.updatedAt).toLocaleDateString(locale),
										})}
									</span>
								</div>
								<span className="shrink-0 tabular-nums text-[length:var(--app-font-size-ui,12px)]">
									{formatTokens(sessionTotal)}
								</span>
							</div>
						))}
					</div>
				)}
			</Card>

			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
				<span>
					{t("tokens.scanned", { files: report.files.scanned, ms: report.scanMs })}
				</span>
				{report.files.failed > 0 ? (
					<span className="text-[var(--warning)]">
						{t("tokens.scanFailed", { count: report.files.failed })}
					</span>
				) : null}
			</div>
		</section>
	);
}

/**
 * The panel the settings page mounts: reads the ledger, then hands it over.
 *
 * It reloads on every session change rather than on a timer — a session changes
 * exactly when a turn finishes, which is exactly when there are new tokens to
 * count, and the incremental parse behind the IPC call makes that cheap.
 */
export function TokenUsageSettings() {
	const { t } = useTranslation();
	const [report, setReport] = useState<TokenUsageReport | null>(null);
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [exportedTo, setExportedTo] = useState<string | null>(null);

	const load = useCallback((rescan = false) => {
		setBusy(true);
		setError(null);
		(rescan ? api.tokenUsageRescan() : api.tokenUsage())
			.then(setReport)
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	}, []);

	useEffect(() => {
		load();
		return api.onSessionsChanged(() => load());
	}, [load]);

	const actions = (
		<div className="flex items-center gap-1.5">
			<Button onClick={() => load(true)} size="icon-xs" variant="ghost" disabled={busy}>
				<RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
			</Button>
			<Button
				onClick={() => {
					setError(null);
					api
						.tokenUsageExport()
						.then(setExportedTo)
						.catch((cause: unknown) => setError(errorMessage(cause)));
				}}
				size="sm"
				variant="chrome-outline"
				disabled={busy || !report}
			>
				<DownloadIcon className="size-3.5" />
				{t("tokens.export")}
			</Button>
		</div>
	);

	const footnotes = (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
			{exportedTo ? <span className="break-all">{t("tokens.exported", { path: exportedTo })}</span> : null}
			{error ? <span className="text-destructive">{error}</span> : null}
		</div>
	);

	if (!report) {
		return (
			<section className="flex flex-col gap-3">
				<div className="flex items-center justify-between gap-3">
					<span className="flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{busy ? <Spinner className="size-3.5" /> : null}
						{busy ? t("tokens.loading") : t("tokens.empty")}
					</span>
					{actions}
				</div>
				{footnotes}
			</section>
		);
	}

	return (
		<>
			<TokenUsageDashboard report={report} actions={actions} />
			{footnotes}
		</>
	);
}
