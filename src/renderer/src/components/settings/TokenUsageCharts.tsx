import { useEffect, useRef, useState } from "react";
import {
	formatCompactTokens,
	type CalendarCell,
	type HeatLevel,
	type TokenCalendar,
} from "../../../../shared/tokenStats";
import { formatTokens } from "../../../../shared/usage";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";

/**
 * The drawings in the token panel.
 *
 * Every one of them encodes a single measure — tokens — so they all share one
 * sequential ramp (`--usage-heat-*`), defined once in the stylesheet with its
 * own dark-mode steps. The one exception is the composition bar, which splits a
 * total into four named parts and therefore needs four identities rather than
 * four magnitudes; it takes the categorical slots (`--usage-input` and friends)
 * and always ships the legend beside it, so the parts are never color alone.
 */

const CELL = 10;
const GAP = 2;
const STEP = CELL + GAP;
/**
 * How close to the card's edge the centre of the tooltip may sit. Half of the
 * longest line it draws — a spelled-out date — so it never runs off the side.
 */
const TOOLTIP_MARGIN = 90;

/** The ramp as CSS variables, indexed by level. Level 0 is "no activity". */
const HEAT_VARS: Record<HeatLevel, string> = {
	0: "var(--usage-heat-0)",
	1: "var(--usage-heat-1)",
	2: "var(--usage-heat-2)",
	3: "var(--usage-heat-3)",
	4: "var(--usage-heat-4)",
};

export function HeatLegend({ max }: { max: number }) {
	const { t } = useTranslation();
	return (
		<div className="flex items-center gap-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
			<span>{t("tokens.legendLess")}</span>
			{([0, 1, 2, 3, 4] as const).map((level) => (
				<span
					key={level}
					className="inline-block rounded-[2px]"
					style={{ width: CELL, height: CELL, background: HEAT_VARS[level] }}
				/>
			))}
			<span>{t("tokens.legendMore")}</span>
			{max > 0 ? (
				<span className="ml-1 tabular-nums">
					{t("tokens.legendMax", { value: formatCompactTokens(max) })}
				</span>
			) : null}
		</div>
	);
}

/**
 * The contribution calendar: one square per day, weeks as columns.
 *
 * Squares are the only mark, so the tooltip is the whole reading layer — a grid
 * of 365 unlabelled cells says nothing on its own about which day is which.
 * It is one popup moved around rather than one per cell, because 365 mounted
 * tooltip subscriptions is a real cost for something only ever shown once.
 */
export function ContributionCalendar({
	calendar,
	locale,
	selected,
	onSelect,
}: {
	calendar: TokenCalendar;
	locale: string;
	selected: string | null;
	onSelect: (date: string | null) => void;
}) {
	const { t } = useTranslation();
	const [hover, setHover] = useState<{ cell: CalendarCell; x: number; y: number } | null>(null);
	const frame = useRef<HTMLDivElement | null>(null);

	/**
	 * Where to put the popup, measured rather than computed from the grid.
	 *
	 * It is anchored to the card, not to the scrolling grid: inside the scroller
	 * it would be clipped at either end of the year, and its width would be
	 * squeezed by however little room was left in the row. Coordinates come off
	 * the cell's own rect, so a scrolled grid stays in register.
	 */
	const anchor = (cell: CalendarCell, element: HTMLElement) => {
		const base = frame.current?.getBoundingClientRect();
		if (!base) return;
		const rect = element.getBoundingClientRect();
		setHover({
			cell,
			x: Math.min(Math.max(rect.left - base.left + rect.width / 2, TOOLTIP_MARGIN), base.width - TOOLTIP_MARGIN),
			y: rect.top - base.top,
		});
	};

	const monthFormat = new Intl.DateTimeFormat(locale, { month: "short" });
	const dayFormat = new Intl.DateTimeFormat(locale, {
		year: "numeric",
		month: "long",
		day: "numeric",
		weekday: "long",
	});
	const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: "short" });

	// A label every column would collide at 12px per week; drop any that would
	// land on top of the one before it.
	const months = calendar.months.filter(
		(entry, index, all) => index === 0 || entry.week - (all[index - 1]?.week ?? -9) >= 3,
	);
	// Row headers are read off the first column, so they name the row they sit
	// beside whatever day the week starts on. Only Monday, Wednesday and Friday
	// are labelled — every row would crowd at this cell size, and naming the same
	// three weekdays under either week start keeps the grid readable.
	const weekdays = (calendar.weeks[0] ?? []).map((cell) => {
		const date = new Date(`${cell.date}T00:00:00`);
		const day = date.getDay();
		return day === 1 || day === 3 || day === 5 ? weekdayFormat.format(date) : "";
	});

	const width = calendar.weeks.length * STEP;

	// A year of weeks is wider than the panel on a narrow window, and the end of
	// the grid is the half anyone came to look at — so when it does overflow it
	// opens showing the most recent weeks rather than last autumn's.
	const scroller = useRef<HTMLDivElement | null>(null);
	const last = calendar.weeks[calendar.weeks.length - 1]?.[6]?.date;
	useEffect(() => {
		const element = scroller.current;
		if (element) element.scrollLeft = element.scrollWidth;
	}, [last]);

	return (
		<div className="relative flex flex-col gap-2" ref={frame}>
			{/* The row headers sit outside the scroller so they stay put: they name
			    the rows of every column, and scrolling them off with the grid would
			    leave the visible weeks unlabelled. */}
			<div className="flex gap-1.5">
				<div
					className="flex shrink-0 flex-col text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground"
					style={{ paddingTop: 14 }}
				>
					{weekdays.map((name, index) => (
						<span
							key={index}
							className="flex items-center leading-none"
							style={{ height: STEP }}
						>
							{name}
						</span>
					))}
				</div>

				<div className="min-w-0 flex-1 overflow-x-auto pb-1" ref={scroller}>
					<div className="relative" style={{ width }}>
						<div className="relative h-3.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
							{months.map((entry) => (
								<span
									key={`${entry.year}-${entry.month}`}
									className="absolute top-0 leading-none"
									style={{ left: entry.week * STEP }}
								>
									{monthFormat.format(new Date(entry.year, entry.month, 1))}
								</span>
							))}
						</div>

						<div className="flex" style={{ gap: GAP }}>
							{calendar.weeks.map((week, weekIndex) => (
								<div
									key={week[0]?.date ?? weekIndex}
									className="flex flex-col"
									style={{ gap: GAP }}
								>
									{week.map((cell, dayIndex) =>
										cell.filler ? (
											<span key={cell.date} style={{ width: CELL, height: CELL }} />
										) : (
											<button
												key={cell.date}
												type="button"
												aria-label={`${cell.date}: ${formatTokens(cell.tokens)}`}
												aria-pressed={selected === cell.date}
												onMouseEnter={(event) => anchor(cell, event.currentTarget)}
												onMouseLeave={() => setHover(null)}
												onFocus={(event) => anchor(cell, event.currentTarget)}
												onBlur={() => setHover(null)}
												onClick={() =>
													onSelect(selected === cell.date ? null : cell.date)
												}
												className={cn(
													"rounded-[2px] outline-none transition-[box-shadow]",
													selected === cell.date &&
														"ring-2 ring-[var(--color-foreground)] ring-offset-1 ring-offset-[var(--background)]",
												)}
												style={{
													width: CELL,
													height: CELL,
													background: HEAT_VARS[cell.level],
												}}
											/>
										),
									)}
								</div>
							))}
						</div>

					</div>
				</div>
			</div>

			{hover ? (
				// Above the cell, or below it for the top rows — the card has no room
				// overhead, and a popup that opened upward there would be cut off by
				// the tiles sitting above the calendar.
				<div
					className={cn(
						"pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-[color:var(--app-surface-divider)] bg-[var(--popover)] px-2 py-1 text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--popover-foreground)] shadow-md",
						hover.y > 2 * STEP ? "-translate-y-full" : "translate-y-3",
					)}
					style={{ left: hover.x, top: hover.y + (hover.y > 2 * STEP ? -4 : CELL) }}
				>
					<div className="font-medium tabular-nums">
						{hover.cell.tokens > 0
							? t("tokens.cellTokens", {
									value: formatTokens(hover.cell.tokens),
									calls: hover.cell.calls,
								})
							: t("tokens.noActivity")}
					</div>
					<div className="text-muted-foreground">
						{dayFormat.format(new Date(`${hover.cell.date}T00:00:00`))}
					</div>
				</div>
			) : null}

			<HeatLegend max={calendar.max} />
		</div>
	);
}

/**
 * Tokens by hour of the local day.
 *
 * Twenty-four slots on the same ramp as the calendar, so "dark means a lot"
 * means the same thing in both. Ticks every six hours keep it readable as a
 * clock rather than as an anonymous row of squares.
 */
export function ActivityClock({
	slots,
}: {
	slots: { hour: number; tokens: number; calls: number; level: HeatLevel }[];
}) {
	const { t } = useTranslation();
	const [hover, setHover] = useState<number | null>(null);
	const active = hover !== null ? slots[hover] : null;

	return (
		<div className="flex flex-col gap-1.5">
			<div className="relative flex items-end gap-[3px]">
				{slots.map((slot) => (
					<button
						key={slot.hour}
						type="button"
						aria-label={`${String(slot.hour).padStart(2, "0")}:00 — ${formatTokens(slot.tokens)}`}
						onMouseEnter={() => setHover(slot.hour)}
						onMouseLeave={() => setHover(null)}
						onFocus={() => setHover(slot.hour)}
						onBlur={() => setHover(null)}
						className="h-5 flex-1 rounded-[3px] outline-none"
						style={{ background: HEAT_VARS[slot.level] }}
					/>
				))}
				{active ? (
					<div
						className="pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-[color:var(--app-surface-divider)] bg-[var(--popover)] px-2 py-1 text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--popover-foreground)] shadow-md"
					>
						<span className="tabular-nums">
							{t("tokens.hourTokens", {
								hour: String(active.hour).padStart(2, "0"),
								value: formatTokens(active.tokens),
								calls: active.calls,
							})}
						</span>
					</div>
				) : null}
			</div>
			{/* Ticks ride the same 24 slots as the cells: spacing them evenly across
			    the row instead would drift a cell and a half by noon, and a clock
			    whose labels point between hours is worse than no labels. */}
			<div className="flex gap-[3px] text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground">
				{slots.map((slot) => (
					<span key={slot.hour} className="flex-1 leading-none">
						{slot.hour % 6 === 0 ? String(slot.hour).padStart(2, "0") : ""}
					</span>
				))}
			</div>
		</div>
	);
}

export interface CompositionPart {
	key: string;
	label: string;
	value: number;
	color: string;
}

/**
 * How a total splits into input, output and the two kinds of cache traffic.
 *
 * Segments are separated by a 2px gap in the surface color rather than by a
 * stroke, and the legend below carries both the name and the number for every
 * part — which is also what keeps the lighter slots legible, since a couple of
 * them sit under 3:1 against a light surface and must not rely on hue alone.
 */
export function CompositionBar({ parts }: { parts: CompositionPart[] }) {
	const total = parts.reduce((sum, part) => sum + part.value, 0);
	const shown = parts.filter((part) => part.value > 0);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full">
				{total > 0 ? (
					shown.map((part) => (
						<span
							key={part.key}
							className="h-full first:rounded-l-full last:rounded-r-full"
							style={{
								width: `${(part.value / total) * 100}%`,
								background: part.color,
							}}
						/>
					))
				) : (
					<span className="h-full w-full rounded-full bg-[var(--usage-heat-0)]" />
				)}
			</div>
			<div className="flex flex-wrap gap-x-4 gap-y-1">
				{parts.map((part) => (
					<span
						key={part.key}
						className="flex items-center gap-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground"
					>
						<span
							className="size-2 shrink-0 rounded-[2px]"
							style={{ background: part.color }}
						/>
						<span>{part.label}</span>
						<span className="tabular-nums text-foreground">
							{formatCompactTokens(part.value)}
						</span>
						<span className="tabular-nums">
							{total > 0 ? `${((part.value / total) * 100).toFixed(1)}%` : "—"}
						</span>
					</span>
				))}
			</div>
		</div>
	);
}

/** A single-measure meter: the share one row holds of the window's tokens. */
export function ShareBar({ share }: { share: number }) {
	return (
		<span className="block h-1.5 w-full overflow-hidden rounded-full bg-[var(--usage-heat-0)]">
			<span
				className="block h-full rounded-full bg-[var(--usage-heat-3)]"
				style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }}
			/>
		</span>
	);
}
