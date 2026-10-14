import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentCell } from "../../../../shared/agent";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { activeTimelineIndex, timelineEntries, timelineTime, userCellSelector } from "../../lib/timeline";

/** Show navigation only when there are multiple user prompts to move between. */
export const TIMELINE_MIN_ENTRIES = 2;

interface Props {
	cells: readonly AgentCell[];
	/** The transcript's scroll container. */
	scrollRef: RefObject<HTMLDivElement | null>;
	onJump: (id: string) => void;
}

/** Space between the chat column's right edge and the rail. */
const RAIL_GAP = 8;
/** The rail's width; it never sits closer than this to the pane's right edge. */
const RAIL_WIDTH = 20;

/**
 * A short vertical rail just right of the chat column, beside the prompts: one tick per prompt the
 * user sent, the one being read highlighted. Hover or focus previews the prompt;
 * clicking scrolls to it. Only prompts already loaded are listed.
 */
export const ConversationTimeline = memo(function ConversationTimeline({ cells, scrollRef, onJump }: Props) {
	const { t } = useTranslation();
	const entries = useMemo(() => timelineEntries(cells), [cells]);
	const [active, setActive] = useState(-1);
	const [preview, setPreview] = useState<{ index: number; top: number } | null>(null);
	/** Offset from the transcript pane's left edge; null until first measured. */
	const [left, setLeft] = useState<number | null>(null);
	const railRef = useRef<HTMLDivElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const ids = useMemo(() => entries.map((entry) => entry.id), [entries]);

	const measure = useCallback(() => {
		const el = scrollRef.current;
		if (!el || !ids.length) return setActive(-1);
		const origin = el.getBoundingClientRect().top - el.scrollTop;
		const tops: number[] = [];
		for (const id of ids) {
			const row = el.querySelector<HTMLElement>(userCellSelector(id));
			tops.push(row ? row.getBoundingClientRect().top - origin : Number.POSITIVE_INFINITY);
		}
		setActive(activeTimelineIndex(tops, el.scrollTop, el.clientHeight));
		// Follow the column, which is centred and capped in width: the rail sits
		// right beside the prompts, and against the pane's edge when the column
		// already fills it.
		const pane = el.parentElement;
		const column = el.firstElementChild;
		if (pane && column) {
			const paneBox = pane.getBoundingClientRect();
			const right = column.getBoundingClientRect().right - paneBox.left;
			const next = Math.round(Math.max(0, Math.min(right + RAIL_GAP, paneBox.width - RAIL_WIDTH - 2)));
			setLeft((value) => (value === next ? value : next));
		}
	}, [ids, scrollRef]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		let frame: number | null = null;
		const schedule = () => {
			if (frame !== null) return;
			frame = requestAnimationFrame(() => { frame = null; measure(); });
		};
		schedule();
		el.addEventListener("scroll", schedule, { passive: true });
		const observer = new ResizeObserver(schedule);
		observer.observe(el);
		if (el.firstElementChild) observer.observe(el.firstElementChild);
		return () => {
			el.removeEventListener("scroll", schedule);
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [measure, scrollRef]);

	// A long rail scrolls by itself; keep the current tick in sight.
	useEffect(() => {
		const list = listRef.current;
		const node = list?.querySelector<HTMLElement>(`[data-timeline-index="${active}"]`);
		if (!list || !node) return;
		const top = node.offsetTop; const bottom = top + node.offsetHeight;
		if (top < list.scrollTop) list.scrollTop = top;
		else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
	}, [active]);

	if (entries.length < TIMELINE_MIN_ENTRIES) return null;

	const show = (index: number, target: HTMLElement) => {
		const rail = railRef.current;
		if (!rail) return;
		const box = target.getBoundingClientRect();
		setPreview({ index, top: box.top + box.height / 2 - rail.getBoundingClientRect().top });
	};
	const shown = preview ? entries[preview.index] : undefined;

	return (
		<nav
			ref={railRef}
			aria-label={t("chat.timeline")}
			data-conversation-timeline=""
			className="pointer-events-none absolute top-1/2 z-10 flex max-h-[min(45%,15rem)] w-5 -translate-y-1/2 flex-col"
			style={left === null ? { right: 2 } : { left }}
		>
			<div
				ref={listRef}
				onMouseLeave={() => setPreview(null)}
				className="conversation-timeline-list pointer-events-auto relative flex min-h-0 w-full flex-col overflow-y-auto overscroll-contain py-1"
			>
				{entries.map((entry, index) => {
					const current = index === active;
					return (
						<button
							key={entry.id}
							type="button"
							data-timeline-index={index}
							aria-current={current ? "location" : undefined}
							aria-label={t("chat.timelineJump", { n: index + 1, text: entry.preview })}
							onClick={() => { onJump(entry.id); setActive(index); }}
							onMouseEnter={(event) => show(index, event.currentTarget)}
							onFocus={(event) => show(index, event.currentTarget)}
							onBlur={() => setPreview(null)}
							className="group flex h-5 min-h-5 w-full shrink-0 items-center justify-start rounded-sm pl-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							<span
								aria-hidden="true"
								className={cn(
									"block h-[2px] rounded-full transition-[width,background-color] duration-150",
									current ? "w-3.5 bg-foreground" : "w-2 bg-muted-foreground/65 group-hover:w-3 group-hover:bg-muted-foreground",
								)}
							/>
						</button>
					);
				})}
			</div>
			{shown && preview ? (
				<div
					role="tooltip"
					className={cn(
						"pointer-events-none absolute right-full mr-1.5 w-max max-w-64 -translate-y-1/2 rounded-md border px-2 py-1 shadow-md",
						"border-[color:var(--app-surface-divider)] bg-popover text-popover-foreground",
						"text-[length:var(--app-font-size-ui-sm,11px)] leading-snug",
					)}
					style={{ top: preview.top }}
				>
					<div className="line-clamp-2 break-words">{shown.preview || t("chat.timelineEmpty")}</div>
					<div className="mt-0.5 text-muted-foreground">
						{t("chat.timelineIndex", { n: preview.index + 1, total: entries.length })}
						{timelineTime(shown.timestamp) ? ` · ${timelineTime(shown.timestamp)}` : ""}
					</div>
				</div>
			) : null}
		</nav>
	);
});
