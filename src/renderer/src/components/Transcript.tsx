import { createContext, Fragment, useContext, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentCell, TurnUsage } from "../../../shared/agent";
import type { WorkflowTask } from "../../../shared/workflow";
import {
	groupTranscriptRows,
	workToolCount,
	type AssistantCellData,
	type WorkItem,
	type WorkRow,
} from "../../../shared/transcript";
import {
	formatCost,
	formatDuration,
	formatPercent,
	formatRate,
	formatTokens,
	usageStats,
} from "../../../shared/usage";
import { useTranslation } from "../i18n";
import { elapsedSeconds, formatElapsed, useNow } from "../lib/elapsed";
import { cn } from "../lib/utils";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, GaugeIcon, Loader2Icon, TriangleAlertIcon, HammerIcon } from "../lib/icons";
import { Spinner } from "./ui/spinner";
import { TaskCard } from "./chat/AgentTask";
import { lastThinkingLine, ThinkingBlock } from "./chat/Thinking";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../surfaceStyles";

function Markdown({ text, user }: { text: string; user?: boolean }) {
	return (
		<div className={cn("chat-markdown", user && "chat-markdown--user")}>
			<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
		</div>
	);
}

function UserCell({
	cell,
	anchor,
}: {
	cell: Extract<AgentCell, { type: "user" }>;
	/** Marks the turn the scroll anchor parks on. */
	anchor?: boolean;
}) {
	return (
		<div className="flex w-full justify-end" data-turn-anchor={anchor ? "" : undefined}>
			<div className="group flex max-w-[80%] flex-col items-end gap-px">
				<div
					className={cn(
						"chat-user-message-bubble w-max min-w-0 max-w-full self-end px-3 py-2.5",
						"rounded-[var(--radius-user-message)] bg-[var(--app-user-message-background)]",
					)}
				>
					<Markdown text={cell.text} user />
				</div>
			</div>
		</div>
	);
}

/** A cell's reasoning, in the shared block the worker panel also uses. */
function CellThinking({ cell }: { cell: AssistantCellData }) {
	return (
		<ThinkingBlock
			text={cell.thinking}
			active={cell.streaming && cell.thinkingEndedAt === undefined}
			startedAt={cell.thinkingStartedAt ?? cell.timestamp}
			endedAt={cell.thinkingEndedAt}
		/>
	);
}

/**
 * What the finished call spent, behind an icon at the foot of the answer.
 *
 * Collapsed to a single glyph by default: this is reference material you go
 * looking for, and a row of numbers under every answer would compete with the
 * answers themselves. Rows the provider did not report are dropped rather than
 * shown as zero — "not reported" and "zero" are different claims.
 */
function UsagePanel({ usage }: { usage: TurnUsage }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const stats = usageStats(usage);

	const rows: { key: string; label: string; value: string }[] = [
		{
			key: "model",
			label: t("usage.model"),
			value: usage.provider ? `${usage.provider}/${usage.model}` : usage.model,
		},
		...(usage.responseModel
			? [{ key: "servedBy", label: t("usage.servedBy"), value: usage.responseModel }]
			: []),
		{ key: "input", label: t("usage.input"), value: formatTokens(usage.input) },
		{ key: "output", label: t("usage.output"), value: formatTokens(usage.output) },
		...(usage.reasoning !== undefined
			? [
					{
						key: "reasoning",
						label: t("usage.reasoning"),
						value: formatTokens(usage.reasoning),
					},
				]
			: []),
		{ key: "cacheRead", label: t("usage.cacheRead"), value: formatTokens(usage.cacheRead) },
		...(usage.cacheWrite > 0
			? [
					{
						key: "cacheWrite",
						label: t("usage.cacheWrite"),
						value: formatTokens(usage.cacheWrite),
					},
				]
			: []),
		...(stats.cacheHitRate !== null
			? [
					{
						key: "cacheHitRate",
						label: t("usage.cacheHitRate"),
						value: formatPercent(stats.cacheHitRate),
					},
				]
			: []),
		{ key: "total", label: t("usage.total"), value: formatTokens(usage.totalTokens) },
		{ key: "calls", label: t("usage.calls"), value: String(usage.calls) },
		...(stats.durationSeconds !== null
			? [
					{
						key: "duration",
						label: t("usage.duration"),
						value: formatDuration(stats.durationSeconds),
					},
				]
			: []),
		// Only worth its own row once tools have pushed the two apart; on a
		// single-call turn it would just repeat the line above it.
		...(stats.modelSeconds !== null &&
		stats.durationSeconds !== null &&
		stats.durationSeconds - stats.modelSeconds >= 0.1
			? [
					{
						key: "modelTime",
						label: t("usage.modelTime"),
						value: formatDuration(stats.modelSeconds),
					},
				]
			: []),
		...(stats.tokensPerSecond !== null
			? [{ key: "speed", label: t("usage.speed"), value: formatRate(stats.tokensPerSecond) }]
			: []),
		...(usage.costUsd !== undefined
			? [{ key: "cost", label: t("usage.cost"), value: formatCost(usage.costUsd) }]
			: []),
	];

	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				aria-expanded={open}
				aria-label={t("usage.title")}
				title={t("usage.title")}
				onClick={() => setOpen((value) => !value)}
				className={cn(
					"inline-flex w-fit items-center rounded p-0.5",
					MUTED_LABEL_TEXT_CLASS_NAME,
				)}
			>
				<GaugeIcon className="size-3.5" />
			</button>
			{open ? (
				<dl
					className={cn(
						"grid w-fit grid-cols-[auto_auto] gap-x-6 gap-y-0.5",
						"border-l border-border/60 pl-3",
						"text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70",
					)}
				>
					{rows.map((row) => (
						<Fragment key={row.key}>
							<dt>{row.label}</dt>
							<dd className="text-right font-mono tabular-nums">{row.value}</dd>
						</Fragment>
					))}
				</dl>
			) : null}
		</div>
	);
}

/**
 * What the model said, with nothing it did: the reasoning that produced this
 * text lives in the work group above it, so the answer reads at the top level.
 */
function MessageCell({ cell }: { cell: AssistantCellData }) {
	return (
		<div className="flex w-full flex-col gap-2">
			{cell.text ? <Markdown text={cell.text} /> : null}
			{cell.error ? (
				<div className="flex items-start gap-1.5 text-[length:var(--app-font-size-chat-meta,10px)] text-destructive">
					<CircleAlertIcon className="mt-px size-3.5 shrink-0" />
					<span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{cell.error}</span>
				</div>
			) : null}
			{cell.usage ? <UsagePanel usage={cell.usage} /> : null}
		</div>
	);
}

function toolArgsPreview(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args);
	} catch {
		return "";
	}
}

interface TaskView {
	tasks: Map<string, WorkflowTask>;
	/** Show the worker's full run in the dock; absent outside a live session. */
	open?: (taskId: string) => void;
}

/**
 * The background workers this turn started, by id.
 *
 * A context rather than a prop: the tool row that needs it sits two levels
 * inside a work group, and threading workers through a component whose subject
 * is elapsed time would make the group know about delegation to pass it on.
 */
const TaskLookupContext = createContext<TaskView>({ tasks: new Map() });

/**
 * The worker a `task` call started, if it is still known.
 *
 * The id comes back in the tool's own result, which is the only thing tying the
 * transcript row to the live worker — the row is a record of the request, the
 * worker is the thing still running.
 */
function taskIdOf(cell: Extract<AgentCell, { type: "tool" }>): string | null {
	if (cell.toolName !== "task" || !cell.output) return null;
	try {
		const parsed: unknown = JSON.parse(cell.output);
		const id = (parsed as { id?: unknown }).id;
		return typeof id === "string" ? id : null;
	} catch {
		return null;
	}
}

function ToolCell({ cell }: { cell: Extract<AgentCell, { type: "tool" }> }) {
	const [open, setOpen] = useState(false);
	const view = useContext(TaskLookupContext);
	const argsText = toolArgsPreview(cell.args);

	// A delegation is not a tool result to unfold — it is a whole session that
	// ran, so the row shows the worker itself rather than the JSON acknowledging
	// that one started.
	const id = taskIdOf(cell);
	const task = id ? view.tasks.get(id) : undefined;
	if (task) return <TaskCard task={task} onOpen={view.open} />;

	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center gap-1.5 text-left"
			>
				{cell.status === "running" ? (
					<Spinner className="size-3.5 text-muted-foreground" />
				) : cell.status === "error" ? (
					<TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />
				) : (
					<HammerIcon className={cn("size-3.5 shrink-0", MUTED_LABEL_TEXT_CLASS_NAME)} />
				)}
				<span className="shrink-0 text-[length:var(--app-font-size-chat,12px)] font-medium">
					{cell.toolName}
				</span>
				{argsText ? (
					<span className={cn("min-w-0 flex-1 truncate font-mono text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
						{argsText}
					</span>
				) : (
					<span className="flex-1" />
				)}
				{cell.status === "pending" ? (
					<Loader2Icon className="size-3 shrink-0 opacity-40" />
				) : null}
			</button>
			{open && cell.output ? (
				<pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-[var(--color-token-text-code-block-background)] p-2.5 font-mono text-[length:var(--app-font-size-chat-code,11px)]">
					{cell.output}
				</pre>
			) : null}
		</div>
	);
}

function NoticeCell({ cell }: { cell: Extract<AgentCell, { type: "notice" }> }) {
	return (
		<div
			className={cn(
				"text-[length:var(--app-font-size-chat-meta,10px)]",
				cell.level === "error"
					? "text-destructive"
					: cell.level === "warning"
						? "text-[var(--warning)]"
						: MUTED_LABEL_TEXT_CLASS_NAME,
			)}
		>
			{cell.text}
		</div>
	);
}

/** The shimmer that stands in for the step the model has not shown yet. */
function PlanningLine() {
	return (
		<div
			className={cn("text-[length:var(--app-font-size-chat,12px)]", MUTED_LABEL_TEXT_CLASS_NAME)}
		>
			<span className="shimmer">Planning Next Step</span>
		</div>
	);
}

/** One line standing in for a step, for the header of a collapsed work group. */
function workItemSummary(item: WorkItem): string {
	switch (item.kind) {
		case "thinking":
			return lastThinkingLine(item.cell.thinking);
		case "tool":
			return item.cell.toolName;
		case "notice":
			return item.cell.text;
	}
}

/**
 * The outermost level of a turn: everything the model did between the prompt
 * and the answer, under one header that can be folded away.
 *
 * Long runs produce hundreds of lines of reasoning and tool traffic, and the
 * answer they were for scrolls off the top before it is read. Open by default —
 * watching the work is the point while it runs — but one click puts a whole
 * run behind a single line, which is what makes a finished transcript
 * readable. The header sits a step above "Thinking for" in size because it
 * contains it.
 */
function WorkingBlock({
	row,
	active,
	waiting,
}: {
	row: WorkRow;
	/** The run is still going, so the elapsed time counts against the clock. */
	active: boolean;
	/** The model owes a next step that has not arrived yet. */
	waiting: boolean;
}) {
	const [open, setOpen] = useState(true);
	const now = useNow(active);
	const end = active ? now : row.endedAt;
	const seconds = elapsedSeconds(row.startedAt, end);
	const tools = workToolCount(row);
	const last = row.items[row.items.length - 1];
	// Collapsed, the header carries what it is standing in for: the step running
	// right now while it runs, and the size of what is folded away once it stops.
	const summary = active
		? waiting
			? "Planning Next Step"
			: last
				? workItemSummary(last)
				: ""
		: `${tools} tool ${tools === 1 ? "call" : "calls"}`;

	return (
		<div className="flex flex-col gap-1.5">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className={cn(
					"inline-flex w-fit items-center gap-1 font-medium",
					"text-[length:calc(var(--app-font-size-chat,12px)*1.15)]",
					MUTED_LABEL_TEXT_CLASS_NAME,
				)}
			>
				{open ? (
					<ChevronDownIcon className="size-4" />
				) : (
					<ChevronRightIcon className="size-4" />
				)}
				<span className={active ? "shimmer" : undefined}>
					{active
						? `Working for ${formatElapsed(seconds)}`
						: `Worked for ${formatElapsed(seconds)}`}
				</span>
			</button>
			{open ? (
				<div className="flex flex-col gap-2 border-l border-border/60 pl-3">
					{row.items.map((item) =>
						item.kind === "thinking" ? (
							<CellThinking key={item.id} cell={item.cell} />
						) : item.kind === "tool" ? (
							<ToolCell key={item.id} cell={item.cell} />
						) : (
							<NoticeCell key={item.id} cell={item.cell} />
						),
					)}
					{waiting ? <PlanningLine /> : null}
				</div>
			) : summary ? (
				<div
					className={cn(
						"truncate border-l border-border/60 pl-3",
						"text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70",
						active && waiting && "shimmer",
					)}
				>
					{summary}
				</div>
			) : null}
		</div>
	);
}

/**
 * True while the run is streaming but the model has produced nothing visible
 * for the current step yet — the tail is the user's prompt, a settled tool
 * call, or an assistant cell that has neither text nor thinking. A running
 * tool speaks for itself, so it suppresses the line.
 */
function waitingOnModel(cells: AgentCell[], streaming: boolean): boolean {
	if (!streaming) return false;
	const last = cells[cells.length - 1];
	if (!last) return true;
	switch (last.type) {
		case "user":
		case "notice":
			return true;
		case "tool":
			return last.status === "done" || last.status === "error";
		case "assistant":
			return last.streaming && !last.text && !last.thinking;
	}
}

export function Transcript({
	cells,
	streaming,
	tasks,
	onOpenTask,
}: {
	cells: AgentCell[];
	streaming?: boolean;
	/** Background workers, so a `task` row can show the worker it started. */
	tasks?: WorkflowTask[];
	onOpenTask?: (taskId: string) => void;
}) {
	const taskLookup = useMemo<TaskView>(
		() => ({
			tasks: new Map((tasks ?? []).map((task) => [task.id, task])),
			open: onOpenTask,
		}),
		[tasks, onOpenTask],
	);
	let lastUserId: string | null = null;
	for (let i = cells.length - 1; i >= 0; i--) {
		if (cells[i].type === "user") {
			lastUserId = cells[i].id;
			break;
		}
	}
	const rows = groupTranscriptRows(cells);
	const waiting = waitingOnModel(cells, streaming === true);
	// An open run owns the wait: the line belongs to the work it is waiting on,
	// and only stands alone when nothing has been done in this turn yet.
	const waitingInWork = waiting && rows[rows.length - 1]?.kind === "work";
	return (
		<TaskLookupContext.Provider value={taskLookup}>
			<div className="flex flex-col gap-4">
				{rows.map((row, index) => {
					const last = index === rows.length - 1;
					switch (row.kind) {
						case "user":
							return (
								<UserCell key={row.id} cell={row.cell} anchor={row.cell.id === lastUserId} />
							);
						case "message":
							return <MessageCell key={row.id} cell={row.cell} />;
						case "thinking":
							return <CellThinking key={row.id} cell={row.cell} />;
						case "notice":
							return <NoticeCell key={row.id} cell={row.cell} />;
						case "work":
							return (
								<WorkingBlock
									key={row.id}
									row={row}
									active={last && streaming === true}
									waiting={last && waitingInWork}
								/>
							);
					}
				})}
				{waiting && !waitingInWork ? <PlanningLine /> : null}
			</div>
		</TaskLookupContext.Provider>
	);
}
