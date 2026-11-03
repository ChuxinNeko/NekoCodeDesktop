import { TaskStatusIcon } from "./AgentTask";
import { memo, useId, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { markdownRemarkPlugins, markdownRehypePlugins } from "../../lib/markdownPlugins";
import type { AgentCell } from "../../../../shared/agent";
import type { ExplorerRun } from "../../../../shared/workflow";
import { useTranslation } from "../../i18n";
import {
	basename,
	explorerStats,
	groupTurns,
	inlineCode,
	locationRange,
	parseReportLocations,
	stepSubject,
	type Location,
	type ToolStep,
	type Turn,
} from "../../lib/fastContext";
import { FileTypeIcon } from "../../lib/fileIcons";
import { ChevronRightIcon, FolderIcon, SearchIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME, SOFT_SURFACE_FILL_CLASS_NAME } from "../../surfaceStyles";
import { lastThinkingLine } from "./Thinking";
import { DisclosureRegion } from "../ui/disclosure-region";
import { MarkdownLink } from "./WebSources";

/** Turns kept on screen while the search runs; older ones fold into a count. */
const LIVE_TURNS = 3;
/** Found locations shown before the list scrolls; each row is one fixed-height line. */
const VISIBLE_LOCATIONS = 5;
const LOCATION_ROW_REM = 1.75;
/** Delay between chips of one turn popping in, so a parallel fan-out reads as one. */
const STAGGER_MS = 45;
const MARKDOWN_COMPONENTS = { a: MarkdownLink };

/**
 * A clock in tenths of a second while `active`. Fast Context is measured in
 * seconds, and a counter stuck on "2s" for a whole second looks stalled.
 */
function useTenths(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const id = window.setInterval(() => setNow(Date.now()), 100);
		return () => window.clearInterval(id);
	}, [active]);
	return now;
}

function seconds(ms: number): string {
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** One call of a turn: what it touched, pulsing while it is out. */
function StepChip({ step, index }: { step: ToolStep; index: number }) {
	const subject = stepSubject(step);
	const live = step.status === "running";
	const failed = step.status === "error";
	// A miss is routine for an explorer — a wrong guess at a path, a pattern
	// with no hits — so it reads as struck through, not as an alarm; hovering
	// says what went wrong.
	const title = failed && step.output ? `${subject.path ?? subject.text}\n${step.output.split("\n", 1)[0]}` : (subject.path ?? subject.text);
	return (
		<span
			title={title}
			style={{ animationDelay: `${index * STAGGER_MS}ms` }}
			className={cn(
				"fast-context-pop relative inline-flex max-w-[16rem] min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5",
				"font-mono text-[length:var(--app-font-size-ui-sm,11px)]",
				SOFT_SURFACE_FILL_CLASS_NAME,
				live && "fast-context-live",
				failed && "text-muted-foreground/60 line-through decoration-muted-foreground/40",
			)}
		>
			{failed ? <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-destructive/80" /> : null}
			{subject.kind === "read" ? (
				<FileTypeIcon name={subject.text} className="size-3 shrink-0" />
			) : subject.kind === "list" ? (
				<FolderIcon className={cn("size-3 shrink-0", MUTED_LABEL_TEXT_CLASS_NAME)} />
			) : (
				<SearchIcon className={cn("size-3 shrink-0", MUTED_LABEL_TEXT_CLASS_NAME)} />
			)}
			<span className="min-w-0 truncate">{subject.text}</span>
			{subject.detail ? <span className="shrink-0 text-muted-foreground/70">{subject.detail}</span> : null}
		</span>
	);
}

function TurnRow({ turn, number }: { turn: Turn; number: number }) {
	return (
		<div className="flex min-w-0 items-start gap-2">
			<span
				className={cn(
					"mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-border/70",
					"text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums",
					MUTED_LABEL_TEXT_CLASS_NAME,
				)}
			>
				{number}
			</span>
			<div className="flex min-w-0 flex-1 flex-wrap gap-1">
				{turn.steps.map((step, index) => (
					<StepChip key={step.id} step={step} index={index} />
				))}
			</div>
		</div>
	);
}

function LocationRow({ location, index, onOpen }: { location: Location; index: number; onOpen?: (path: string) => void }) {
	const { t } = useTranslation();
	const range = locationRange(location);
	const dir = location.path.includes("/") ? location.path.slice(0, location.path.lastIndexOf("/") + 1) : "";
	return (
		<button
			type="button"
			disabled={!onOpen}
			title={onOpen ? t("fastCard.openFile") : location.path}
			onClick={() => onOpen?.(location.path)}
			style={{ animationDelay: `${index * STAGGER_MS}ms` }}
			className={cn(
				"fast-context-pop group flex h-7 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-1.5 text-left",
				onOpen && "hover:bg-[var(--color-background-elevated-secondary)]",
			)}
		>
			<FileTypeIcon name={basename(location.path)} className="size-3.5 shrink-0" />
			<span className="flex min-w-0 shrink-0 items-baseline font-mono text-[length:var(--app-font-size-ui-sm,11px)] max-w-[55%]">
				<span className="truncate text-muted-foreground/70">{dir}</span>
				<span className="shrink-0 text-foreground">{basename(location.path)}</span>
			</span>
			{range ? (
				<span
					className={cn(
						"shrink-0 rounded px-1 font-mono text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums",
						SOFT_SURFACE_FILL_CLASS_NAME,
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					{range}
				</span>
			) : null}
			<span
				title={location.note}
				className={cn("min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}
			>
				{inlineCode(location.note).map((part, index) =>
					part.code ? (
						<code key={index} className="rounded bg-[var(--color-token-text-code-block-background)] px-0.5 font-mono text-foreground/80">
							{part.text}
						</code>
					) : (
						<span key={index}>{part.text}</span>
					),
				)}
			</span>
		</button>
	);
}

/**
 * A compact subagent summary in the transcript, with the full search in the dock.
 * Without a dock callback it remains an inline disclosure. Reports and file
 * locations come from the persisted tool cell, so they survive the live run.
 */
export const FastContextCard = memo(function FastContextCard({
	cell,
	run,
	onOpenFile,
	onOpenDetails,
	docked = false,
}: {
	cell: Extract<AgentCell, { type: "tool" }>;
	/** The live run, while the session still knows it. */
	run?: ExplorerRun;
	onOpenFile?: (path: string) => void;
	onOpenDetails?: (toolCallId: string) => void;
	docked?: boolean;
}) {
	const { t } = useTranslation();
	// The row decides when it is over: the explorer can finish a moment before
	// its report reaches the row, and "found 0" in between would be a lie.
	const status: ExplorerRun["status"] =
		cell.status === "done"
			? "completed"
			: cell.status === "error"
				? run?.status === "cancelled"
					? "cancelled"
					: "failed"
				: run && run.status !== "running" && run.status !== "completed"
					? run.status
					: "running";
	const running = status === "running";
	const [open, setOpen] = useState(docked);
	const detailId = useId();
	const [details, setDetails] = useState(docked);
	const now = useTenths(running);

	const query = typeof (cell.args as { query?: unknown } | null)?.query === "string" ? (cell.args as { query: string }).query : "";
	const steps = run?.steps ?? [];
	const turns = useMemo(() => groupTurns(steps), [steps]);
	const stats = useMemo(() => explorerStats(steps), [steps]);
	const report = cell.status === "done" ? cell.output : "";
	const locations = useMemo(() => parseReportLocations(report), [report]);
	// The list opens scrolled to its end. Set when the list appears or changes,
	// not on every render, so scrolling back up is left alone while the card
	// keeps re-rendering around it.
	const locationList = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const list = locationList.current;
		if (list) list.scrollTop = list.scrollHeight;
	}, [locations, open, status]);
	const startedAt = run?.startedAt ?? cell.startedAt ?? cell.timestamp;
	const endedAt = run?.endedAt ?? (running ? undefined : cell.timestamp);
	const elapsed = run || running ? (endedAt ?? now) - startedAt : null;

	const newest = steps[steps.length - 1];
	const reasoning = running && newest?.kind === "thinking" && newest.endedAt === undefined ? lastThinkingLine(newest.text) : null;
	const hidden = running && !details ? Math.max(0, turns.length - LIVE_TURNS) : 0;
	const shownTurns = hidden ? turns.slice(hidden) : turns;

	const summary = running
		? [
				stats.searches ? t("fastCard.stats.searches", { count: stats.searches }) : null,
				stats.files ? t("fastCard.stats.files", { count: stats.files }) : null,
			]
		: [status === "completed" ? t("fastCard.found", { count: locations.length }) : t(status === "cancelled" ? "fastCard.cancelled" : "fastCard.failed")];
	const meta = [...summary.filter(Boolean), elapsed !== null ? seconds(elapsed) : null].filter(Boolean).join(" · ");

	const activity = newest?.kind === "tool" ? `${newest.toolName} ${stepSubject(newest).text}`
		: newest?.kind === "thinking" || newest?.kind === "message" ? lastThinkingLine(newest.text) : "";
	const trailing = running ? activity || t("fastCard.starting") : meta;
	return (
		<div data-fast-context={docked ? "detail" : "summary"} className="min-w-0">
			<div className="relative my-0.5 mb-1.5 flex min-w-0 items-center rounded-lg border border-border bg-muted/20 transition-colors duration-120 hover:border-muted-foreground/40 hover:bg-muted/40 focus-within:border-ring motion-reduce:transition-none">
				<button type="button" title={["Fast Context", query, trailing].filter(Boolean).join(" · ")}
					aria-label={`Fast Context · ${query} · ${running ? t("workflow.running") : t(status === "completed" ? "workflow.completed" : status === "cancelled" ? "fastCard.cancelled" : "fastCard.failed")}`}
					aria-expanded={onOpenDetails ? undefined : open} aria-controls={onOpenDetails ? undefined : detailId}
					onClick={() => onOpenDetails ? onOpenDetails(cell.toolCallId) : setOpen(value => !value)}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-[9px] pl-3 pr-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring">
					<TaskStatusIcon task={{ status }} />
					<span className="flex min-w-0 flex-1 items-center leading-[1.4]">
						<span className={cn("min-w-0 truncate text-[13px] font-medium", running && "shimmer")}>Fast Context{query ? ` · ${query}` : ""}</span>
						<span className="ml-1.5 max-w-[50%] shrink truncate text-[12px] text-muted-foreground/75"><span key={trailing} className="task-activity-flip inline-block max-w-full truncate align-middle">· {trailing}</span></span>
					</span>
					{run?.model ? <span title={run.model} className="max-w-[25%] truncate text-[12px] text-muted-foreground/75">{run.model.split("/").pop()}</span> : null}
					<ChevronRightIcon aria-hidden="true" data-open={open} className={cn("size-[18px] shrink-0 text-muted-foreground", !onOpenDetails && "workflow-chevron")} />
				</button>
			</div>
			<DisclosureRegion id={detailId} open={!onOpenDetails && open}>
				<div className="flex flex-col gap-1.5 border-t border-border/40 px-2.5 py-2">
					{/* The search: live while it runs, on request once it is over. */}
					{running || details ? (
						<div className={cn("flex flex-col gap-1.5", hidden > 0 && "fast-context-fade-top")}>
							{hidden > 0 ? (
								<span className={cn("pl-6 text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
									{t("fastCard.earlierTurns", { count: hidden })}
								</span>
							) : null}
							{shownTurns.map((turn) => (
								<TurnRow key={turn.id} turn={turn} number={turns.indexOf(turn) + 1} />
							))}
							{running && turns.length === 0 ? (
								<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
									<span className="shimmer">{t("fastCard.starting")}</span>
								</span>
							) : null}
							{reasoning ? (
								<span className="truncate pl-6 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">{reasoning}</span>
							) : null}
							{!running && !run ? (
								<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
									{t("fastCard.stepsGone")}
								</span>
							) : null}
						</div>
					) : null}

					{!running && status === "completed" ? (
						locations.length ? (
							// Capped so a long report scrolls inside the card instead of
							// stretching the transcript around it.
							<div
								ref={locationList}
								className="flex flex-col overflow-y-auto overscroll-contain"
								style={{ maxHeight: `${VISIBLE_LOCATIONS * LOCATION_ROW_REM}rem` }}
							>
								{locations.map((location, index) => (
									<LocationRow key={`${location.path}:${location.start ?? ""}`} location={location} index={index} onOpen={onOpenFile} />
								))}
							</div>
						) : (
							<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
								{t("fastCard.noLocations")}
							</span>
						)
					) : null}

					{!running && status !== "completed" && cell.output ? (
						<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
							{cell.output}
						</pre>
					) : null}

					{!running && status === "completed" && details && report ? (
						<div className="chat-markdown max-h-80 overflow-auto rounded-md border border-border/50 p-2 text-[length:var(--app-font-size-ui-sm,11px)]">
							<ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={MARKDOWN_COMPONENTS}>
								{report}
							</ReactMarkdown>
						</div>
					) : null}

					{!running ? (
						<button
							type="button"
							onClick={() => setDetails((value) => !value)}
							className="w-fit text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--color-token-text-link-foreground)] hover:underline"
						>
							{t(details ? "fastCard.hideDetails" : "fastCard.showDetails")}
						</button>
					) : null}
				</div>
			</DisclosureRegion>
		</div>
	);
});
