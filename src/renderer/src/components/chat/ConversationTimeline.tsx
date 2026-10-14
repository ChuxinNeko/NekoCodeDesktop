import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentCell } from "../../../../shared/agent";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { activeTimelineIndex, timelineEntries, timelineTime } from "../../lib/timeline";

/** Fewer prompts than this need no navigation: the whole turn is on screen. */
export const TIMELINE_MIN_ENTRIES = 2;

/** The row of a prompt in the transcript; `Transcript` tags each user cell with it. */
export const userCellSelector = (id: string) => `[data-user-cell="${CSS.escape(id)}"]`;

interface Props {
	cells: readonly AgentCell[];
	/** The transcript's scroll container. */
	scrollRef: RefObject<HTMLDivElement | null>;
	onJump: (id: string) => void;
}

/**
 * A vertical rail on the right edge of the transcript: one tick per prompt the
 * user sent, the one being read highlighted. Hover or focus previews the prompt;
 * clicking scrolls to it. Only prompts already loaded are listed.
 */
export const ConversationTimeline = memo(function ConversationTimeline({ cells, scrollRef, onJump }: Props) {
	const { t } = useTranslation();
	const entries = useMemo(() => timelineEntries(cells), [cells]);
	const [active, setActive] = useState(-1);
	const [preview, setPreview] = useState<{ index: number; top: number } | null>(null);
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
			className="pointer-events-none absolute top-6 bottom-14 right-1 z-10 flex w-5 items-center"
		>
			<div
				ref={listRef}
				onMouseLeave={() => setPreview(null)}
				className="conversation-timeline-list pointer-events-auto flex max-h-full w-full flex-col overflow-y-auto overscroll-contain py-1"
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
							className="group flex h-6 min-h-6 w-full shrink-0 items-center justify-end rounded-sm pr-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							<span
								aria-hidden="true"
								className={cn(
									"block h-[2px] rounded-full transition-[width,background-color] duration-150",
									current ? "w-3.5 bg-foreground" : "w-2 bg-muted-foreground/45 group-hover:w-3 group-hover:bg-muted-foreground",
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
