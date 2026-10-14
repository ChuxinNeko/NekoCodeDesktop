import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { AgentCell, ModelOption } from "../../../shared/agent";
import type { CheckpointSummary } from "../../../shared/checkpoints";
import type { ExplorerRun, WorkflowTask } from "../../../shared/workflow";
import {
	foldSettledTurns,
	groupTranscriptRows,
	workToolCount,
	type AssistantCellData,
	type WorkItem,
	type WorkRow,
} from "../../../shared/transcript";
import { MessageActions } from "./chat/MessageActions";
import { UsageModelsContext } from "./chat/UsagePanel";
import { completedTurnChanges } from "../lib/turnChanges";
import { useReducedMotion } from "../lib/motion";
import { DisclosureRegion } from "./ui/disclosure-region";
import { useTranslation, type TranslateFn } from "../i18n";
import { elapsedSeconds, formatElapsed, useNow } from "../lib/elapsed";
import { cn } from "../lib/utils";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, FileIcon, Undo2Icon } from "../lib/icons";
import { highlightWhenIdle } from "../lib/codeHighlight";
import { TaskCard } from "./chat/AgentTask";
import { FastContextCard } from "./chat/FastContextCard";
import { EditedFilesCard } from "./chat/EditedFilesCard";
import {
	CARD_CLASS_NAME,
	CARD_HEADER_CLASS_NAME,
	ComputerUseCard,
	ToolCall,
	ToolLine,
	ToolOutputContext,
	toolPhase,
	toolSummary,
	workUnits,
} from "./chat/ToolCalls";
import { lastThinkingLine, ThinkingBlock } from "./chat/Thinking";
import { SourceList } from "./chat/WebSources";
import { Markdown } from "./chat/Markdown";
import { collectWebTitles, WebTitlesContext } from "../lib/webSources";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../surfaceStyles";
import { CommandStopContext, type StopCommand } from "./chat/CommandStopButton";

// The row components below are memoized on their props. Snapshots reach them
// structurally shared (see `shareStructure`), so a settled cell is the same
// object from one streamed token to the next and its row is skipped.
const UserCell = memo(function UserCell({
	cell,
	anchor,
	checkpoint,
	onRestore,
	restoreDisabled,
}: {
	cell: Extract<AgentCell, { type: "user" }>;
	/** Marks the turn the scroll anchor parks on. */
	anchor?: boolean;
	/** The point the project can be put back to, just before this prompt ran. */
	checkpoint?: CheckpointSummary;
	onRestore?: (checkpoint: CheckpointSummary) => void;
	/** A run is in flight, so a rewind would race it. */
	restoreDisabled?: boolean;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex w-full justify-end" data-turn-anchor={anchor ? "" : undefined} data-user-cell={cell.id}>
			<div className="group flex max-w-[80%] flex-col items-end gap-px">
				<div
					className={cn(
						"chat-user-message-bubble w-max min-w-0 max-w-full self-end px-3 py-2.5",
						"rounded-[var(--radius-user-message)] bg-[var(--app-user-message-background)]",
					)}
				>
					<Markdown text={cell.text} user />
				</div>
				{/* The rewind belongs on the prompt it would undo — that is the thing
				    the user is looking at when they decide this turn was a mistake.
				    Hidden until the row is hovered, because every turn has one and a
				    permanent button on each would read as part of the message. */}
				{checkpoint && onRestore ? (
					<button
						type="button"
						disabled={restoreDisabled}
						title={t("checkpoint.restoreHint")}
						aria-label={t("checkpoint.restoreAria", { label: checkpoint.label })}
						onClick={() => onRestore(checkpoint)}
						className={cn(
							"mt-0.5 inline-flex items-center gap-1 rounded px-1 py-0.5 opacity-0 transition-opacity",
							"text-[length:var(--app-font-size-ui-xs,10px)]",
							MUTED_LABEL_TEXT_CLASS_NAME,
							"group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground",
							"disabled:pointer-events-none",
						)}
					>
						<Undo2Icon className="size-3" />
						{t("checkpoint.restoreHere")}
					</button>
				) : null}
			</div>
		</div>
	);
});

/** A cell's reasoning, in the shared block the worker panel also uses. */
const CellThinking = memo(function CellThinking({ cell }: { cell: AssistantCellData }) {
	return (
		<ThinkingBlock
			text={cell.thinking}
			active={cell.streaming && cell.thinkingEndedAt === undefined}
			startedAt={cell.thinkingStartedAt ?? cell.timestamp}
			endedAt={cell.thinkingEndedAt}
		/>
	);
});

/**
 * What the model said, with nothing it did: the reasoning that produced this
 * text lives in the work group above it, so the answer reads at the top level.
 * The reply that closes a turn carries the turn's actions — copy, branch,
 * usage. A remark in the middle of a run does not: a button row under it would
 * read as part of the text, and a branch cut there would end mid-run.
 */
const MessageCell = memo(function MessageCell({
	cell,
	closesTurn,
	afterWork,
	onFork,
}: {
	cell: AssistantCellData;
	closesTurn: boolean;
	/** Concludes a run of work: a rule sets the answer apart from the process above it. */
	afterWork?: boolean;
	onFork?: (cellId: string) => Promise<void> | void;
}) {
	return (
		<div className={cn("flex w-full flex-col gap-2", afterWork && "border-t border-border/50 pt-4")}>
			{cell.text ? <Markdown text={cell.text} /> : null}
			{/* Once the answer is whole: a list that reshuffles as citations stream in reads as flicker. */}
			{cell.text && !cell.streaming ? <SourceList text={cell.text} /> : null}
			{cell.error ? (
				<div className="flex items-start gap-1.5 text-[length:var(--app-font-size-chat-meta,10px)] text-destructive">
					<CircleAlertIcon className="mt-px size-3.5 shrink-0" />
					<span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{cell.error}</span>
				</div>
			) : null}
			{closesTurn && !cell.streaming && (cell.text || cell.usage) ? (
				<MessageActions cell={cell} onFork={cell.text ? onFork : undefined} />
			) : null}
		</div>
	);
});

interface TaskView {
	tasks: Map<string, WorkflowTask>;
	/** Live Fast Context runs, by the `code_search` call that started each. */
	explorers?: Map<string, ExplorerRun>;
	/** Show the worker's full run in the dock; absent outside a live session. */
	open?: (taskId: string) => void;
	/** Show a file the agent touched in the dock's Files pane. */
	openFile?: (path: string) => void;
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

type FileEditLine = { kind: "add" | "remove" | "context"; text: string };
type FileEditPreview = { path: string; lines: FileEditLine[] };

function textLines(text: string): string[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function resultDiffLines(diff: string): FileEditLine[] {
	return diff.split("\n").map((raw) => {
		const match = /^([+\- ]) *\d+ (.*)$/.exec(raw);
		if (!match) return { kind: "context", text: raw };
		const kind = match[1] === "+" ? "add" : match[1] === "-" ? "remove" : "context";
		return { kind, text: match[2] };
	});
}

function fileEditPreview(cell: Extract<AgentCell, { type: "tool" }>): FileEditPreview | null {
	if (cell.toolName !== "edit" && cell.toolName !== "write") return null;
	const args =
		typeof cell.args === "object" && cell.args !== null
			? (cell.args as Record<string, unknown>)
			: {};
	// Models can emit edits/content before path. The tool name is enough to
	// mount the card; do not hide received code while waiting for its filename.
	const rawPath = args.path ?? args.file_path;

	let lines: FileEditLine[] = [];
	if (cell.toolName === "write") {
		if (typeof args.content === "string") {
			lines = textLines(args.content).map((text) => ({ kind: "add", text }));
		}
	} else {
		const details =
			typeof cell.details === "object" && cell.details !== null
				? (cell.details as Record<string, unknown>)
				: null;
		if (typeof details?.diff === "string" && details.diff) {
			lines = resultDiffLines(details.diff);
		} else {
			const edits: { oldText?: unknown; newText?: unknown }[] = [
				...(Array.isArray(args.edits) ? args.edits : []),
				...(typeof args.oldText === "string" || typeof args.newText === "string"
					? [{ oldText: args.oldText, newText: args.newText }]
					: []),
			];
			for (const edit of edits) {
				if (typeof edit !== "object" || edit === null) continue;
				if (typeof edit.oldText === "string") {
					for (const text of textLines(edit.oldText)) lines.push({ kind: "remove", text });
				}
				if (typeof edit.newText === "string") {
					for (const text of textLines(edit.newText)) lines.push({ kind: "add", text });
				}
			}
		}
	}
	return { path: typeof rawPath === "string" ? rawPath : "", lines };
}

function FileEditCell({
	cell,
	preview,
	active,
}: {
	cell: Extract<AgentCell, { type: "tool" }>;
	preview: FileEditPreview;
	active: boolean;
}) {
	const { t } = useTranslation();
	const lines = preview.lines;
	const live = active && (cell.status === "pending" || cell.status === "running");
	const [open, setOpen] = useState(true);
	const [highlighted, setHighlighted] = useState<{ code: string; path: string; lines: string[] } | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const followRef = useRef(true);
	const wasLive = useRef(live);
	const code = lines.map((line) => line.text).join("\n");

	// Follow actual input/result updates, including a partial last line. Leave
	// history at the top, and let a reader scroll back without being pulled down.
	useEffect(() => {
		const body = bodyRef.current;
		if (body && followRef.current && (live || wasLive.current)) body.scrollTop = body.scrollHeight;
		wasLive.current = live;
	}, [code, live, open]);

	// Colors are for reading, and only the edits on screen are being read: one
	// scrolled out of view keeps its plain text until it is scrolled to.
	const [seen, setSeen] = useState(false);
	useEffect(() => {
		const body = bodyRef.current;
		if (seen || !body) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
		});
		observer.observe(body);
		return () => observer.disconnect();
	}, [seen, open]);

	useEffect(() => {
		// Do not re-tokenize the entire growing file on every input delta.
		// Plain text arrives immediately; syntax colors settle with the input.
		if (cell.inputStreaming || !seen) return;
		const controller = new AbortController();
		highlightWhenIdle(code, preview.path, controller.signal)
			.then((html) => {
				if (controller.signal.aborted || !html) return;
				const doc = new DOMParser().parseFromString(html, "text/html");
				const spans = Array.from(doc.querySelectorAll(".line"));
				setHighlighted({ code, path: preview.path, lines: spans.map((node) => node.innerHTML) });
			})
			.catch(() => undefined);
		return () => controller.abort();
	}, [code, preview.path, cell.inputStreaming, seen]);

	const basename = preview.path.split(/[\\/]/).pop() || t(cell.toolName === "write" ? "fileEdit.write" : "fileEdit.edit");
	const additions = lines.filter((line) => line.kind === "add").length;
	const deletions = lines.filter((line) => line.kind === "remove").length;
	const phaseLabel = cell.inputStreaming
		? t("fileEdit.generating")
		: cell.status === "running"
			? t("fileEdit.applying")
			: cell.status === "pending" ? t("fileEdit.pending") : null;

	return (
		<div
			data-file-edit={cell.toolCallId}
			className={cn(CARD_CLASS_NAME, live && "tool-scan", active && "tool-enter")}
		>
			<ToolLine
				phase={toolPhase(cell, active)}
				icon={FileIcon}
				fileIconName={basename}
				label={t(cell.toolName === "write" ? "fileEdit.write" : "fileEdit.edit")}
				subject={preview.path ? basename : null}
				title={preview.path}
				meta={
					<>
						{phaseLabel ? <span>{phaseLabel}</span> : null}
						{additions > 0 ? <span className="text-success">+{additions.toLocaleString()}</span> : null}
						{deletions > 0 ? <span className="text-destructive">−{deletions.toLocaleString()}</span> : null}
					</>
				}
				expandable
				open={open}
				onClick={() => setOpen((value) => !value)}
				className={CARD_HEADER_CLASS_NAME}
			/>
			<DisclosureRegion open={open}>
			<div
				ref={bodyRef}
				onScroll={(event) => {
					const body = event.currentTarget;
					followRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
				}}
				className="max-h-64 overflow-auto border-t border-border/40 font-mono text-[length:var(--app-font-size-chat-code,11px)]"
			>
				{cell.inputStreaming && lines.length === 0 ? (
					<div className="px-3 py-2 font-sans text-muted-foreground">{t("fileEdit.waitingForContent")}</div>
				) : null}
				{lines.map((line, index) => {
					const html = highlighted?.code === code && highlighted.path === preview.path
						? highlighted.lines[index] : undefined;
					return (
						<div
							key={`${index}:${line.kind}`}
							className={cn(
								"min-h-5 whitespace-pre px-3 leading-5",
								line.kind === "add" &&
									"bg-[color-mix(in_srgb,var(--success)_16%,transparent)]",
								line.kind === "remove" &&
									"bg-[color-mix(in_srgb,var(--destructive)_16%,transparent)]",
							)}
						>
							{html !== undefined ? (
								<span dangerouslySetInnerHTML={{ __html: html }} />
							) : (
								line.text
							)}
						</div>
					);
				})}
			</div>
			</DisclosureRegion>
		</div>
	);
}

const ToolCell = memo(function ToolCell({ cell, active }: { cell: Extract<AgentCell, { type: "tool" }>; active: boolean }) {
	const view = useContext(TaskLookupContext);

	// A delegation is not a tool result to unfold — it is a whole session that
	// ran, so the row shows the worker itself rather than the JSON acknowledging
	// that one started.
	const id = taskIdOf(cell);
	const task = id ? view.tasks.get(id) : undefined;
	if (task) return <TaskCard task={task} onOpen={view.open} />;
	// A search is a run too: the explorer's fan-out while it works, what it
	// found once it is done.
	if (cell.toolName === "code_search")
		return <FastContextCard cell={cell} run={view.explorers?.get(cell.toolCallId)} onOpenFile={view.openFile} />;

	const fileEdit = cell.status === "error" ? null : fileEditPreview(cell);
	if (fileEdit) return <FileEditCell cell={cell} preview={fileEdit} active={active} />;

	return <ToolCall cell={cell} active={active} onOpenFile={view.openFile} />;
});

const NoticeCell = memo(function NoticeCell({ cell }: { cell: Extract<AgentCell, { type: "notice" }> }) {
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
});

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
function workItemSummary(item: WorkItem, t: TranslateFn): string {
	switch (item.kind) {
		case "thinking":
			return lastThinkingLine(item.cell.thinking);
		case "tool":
			return toolSummary(item.cell, t);
		case "notice":
			return item.cell.text;
		case "message":
			return lastThinkingLine(item.cell.text);
	}
}

/** A remark the model made on the way, inside the run it was part of. */
function RemarkCell({ cell }: { cell: AssistantCellData }) {
	return cell.text ? <Markdown text={cell.text} /> : null;
}

/**
 * A work row is regrouped from the cells on every render, so the row object is
 * always new; what it shows only changes when one of its cells does.
 */
/**
 * One transcript row, which the browser may skip laying out while it is off
 * screen. A long session's rows carry whole files and command outputs, and
 * laying out all of them is what opening one used to wait on; with this only
 * the rows in view are measured, the rest hold the height they last rendered
 * at (or an estimate, until they first do).
 */
const TRANSCRIPT_ROW_CLASS_NAME =
	"flex flex-col gap-4 [content-visibility:auto] [contain-intrinsic-size:auto_160px]";

function sameWorkingBlock(
	prev: { row: WorkRow; active: boolean; waiting: boolean; settling: boolean },
	next: { row: WorkRow; active: boolean; waiting: boolean; settling: boolean },
): boolean {
	if (prev.active !== next.active || prev.waiting !== next.waiting || prev.settling !== next.settling) return false;
	const a = prev.row;
	const b = next.row;
	if (a.startedAt !== b.startedAt || a.endedAt !== b.endedAt || a.items.length !== b.items.length) return false;
	return a.items.every((item, index) => item.cell === b.items[index].cell && item.kind === b.items[index].kind);
}

/**
 * The outermost level of a turn: everything the model did between the prompt
 * and the answer, under one header that can be folded away.
 *
 * Long runs produce hundreds of lines of reasoning and tool traffic, and the
 * answer they were for scrolls off the top before it is read. Open while it
 * runs — watching the work is the point then — and closed once it is over: a
 * finished turn is folded into a group of its own (see `foldSettledTurns`),
 * which mounts here collapsed, leaving the answer as the thing to read. The
 * header sits a step above "Thinking for" in size because it contains it.
 */
const WorkingBlock = memo(function WorkingBlock({
	row,
	active,
	waiting,
	settling,
}: {
	row: WorkRow;
	/** The run is still going, so the elapsed time counts against the clock. */
	active: boolean;
	/** The model owes a next step that has not arrived yet. */
	waiting: boolean;
	settling: boolean;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(active);
	const reducedMotion = useReducedMotion();
	useEffect(() => { if (settling) setOpen(false); }, [settling]);
	const now = useNow(active);
	const end = active ? now : row.endedAt;
	const seconds = elapsedSeconds(row.startedAt, end);
	const tools = workToolCount(row);
	const last = row.items[row.items.length - 1];
	// Collapsed, the block says what it is standing in for: the step running
	// right now while it runs, under the header; once it stops, the size of what
	// is folded away, beside it — one line, so a finished turn reads as a rule.
	const summary = active ? (waiting ? "Planning Next Step" : last ? workItemSummary(last, t) : "") : "";
	const size = active ? null : `${tools} tool ${tools === 1 ? "call" : "calls"}`;

	return (
		<div className="flex flex-col gap-1.5">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className={cn(
					"inline-flex w-fit items-center gap-1 font-medium",
					"text-[length:var(--app-font-size-chat-body,13px)]",
					MUTED_LABEL_TEXT_CLASS_NAME,
				)}
			>
				<ChevronRightIcon className="workflow-chevron size-4" data-open={open} />
				{active ? reducedMotion ? <span aria-hidden="true" className="size-3 rounded-full bg-primary/40" /> : <ThinkingOrb state="solving" size={20} /> : null}
				<span>
					{active
						? `Working for ${formatElapsed(seconds)}`
						: `Worked for ${formatElapsed(seconds)}`}
				</span>
				{size ? (
					<span className="font-normal text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
						· {size}
					</span>
				) : null}
			</button>
			<DisclosureRegion open={open}>
				<div className="flex flex-col gap-2 border-l border-border/60 pl-3">
					{workUnits(row.items, active).map((unit) => {
						if (unit.kind === "computer")
							return <ComputerUseCard key={unit.id} steps={unit.steps} active={active} pending={unit.pending} />;
						const item = unit.item;
						return item.kind === "thinking" ? (
							<CellThinking key={item.id} cell={item.cell} />
						) : item.kind === "tool" ? (
							<ToolCell key={item.id} cell={item.cell} active={active} />
						) : item.kind === "message" ? (
							<RemarkCell key={item.id} cell={item.cell} />
						) : (
							<NoticeCell key={item.id} cell={item.cell} />
						);
					})}
					{waiting ? <PlanningLine /> : null}
				</div>
			</DisclosureRegion>
			{!open && !settling && summary ? (
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
}, sameWorkingBlock);

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

const EMPTY_MODELS: readonly ModelOption[] = [];

const TranscriptView = function Transcript({
	cells,
	models,
	streaming,
	settling = false,
	tasks,
	explorers,
	onOpenTask,
	onOpenFile,
	checkpoints,
	composerCheckpointId,
	onRestoreCheckpoint,
	onOpenReview,
	onLoadToolOutput,
	onForkMessage,
	onStopCommand,
}: {
	cells: AgentCell[];
	models?: readonly ModelOption[];
	streaming?: boolean;
	settling?: boolean;
	/** Background workers, so a `task` row can show the worker it started. */
	tasks?: WorkflowTask[];
	/** Fast Context runs, so a `code_search` row can show its search live. */
	explorers?: ExplorerRun[];
	onOpenTask?: (taskId: string) => void;
	/** Show a file a tool row references in the dock's Files pane. */
	onOpenFile?: (path: string) => void;
	/** Restore points, so a prompt can offer the rewind of its own turn. */
	checkpoints?: readonly CheckpointSummary[];
	/** This checkpoint is already displayed above the composer; avoid a duplicate. */
	composerCheckpointId?: string;
	onRestoreCheckpoint?: (checkpoint: CheckpointSummary) => void;
	/** Open the review panel — the edit summary card's "Review" action. */
	onOpenReview?: () => void;
	/**
	 * Fetch the rest of a trimmed tool result. Only remote surfaces pass one; a
	 * local transcript already holds every result whole.
	 */
	onLoadToolOutput?: (toolCallId: string, offset: number) => Promise<{ text: string; total: number }>;
	/** Branch the conversation at a reply into a session of its own. */
	onForkMessage?: (cellId: string) => Promise<void> | void;
	onStopCommand?: StopCommand;
}) {
	// The handlers come from parents that recreate them every render. Reached
	// through a ref, they stop being a reason for every row to re-render: the
	// context value and the memoized rows only change with what they show.
	const handlers = useRef({ onOpenTask, onOpenFile, onRestoreCheckpoint, onForkMessage, onStopCommand });
	handlers.current = { onOpenTask, onOpenFile, onRestoreCheckpoint, onForkMessage, onStopCommand };
	const stopCommand = useCallback((id: string) => handlers.current.onStopCommand?.(id) ?? Promise.resolve(false), []);
	const forkMessage = useCallback((cellId: string) => handlers.current.onForkMessage?.(cellId), []);
	const openTask = useCallback((taskId: string) => handlers.current.onOpenTask?.(taskId), []);
	const openFile = useCallback((path: string) => handlers.current.onOpenFile?.(path), []);
	const restoreCheckpoint = useCallback(
		(checkpoint: CheckpointSummary) => handlers.current.onRestoreCheckpoint?.(checkpoint),
		[],
	);
	const canOpenTask = onOpenTask !== undefined;
	const canOpenFile = onOpenFile !== undefined;
	const taskLookup = useMemo<TaskView>(
		() => ({
			tasks: new Map((tasks ?? []).map((task) => [task.id, task])),
			explorers: new Map(
				(explorers ?? []).flatMap((run) => (run.toolCallId ? [[run.toolCallId, run] as const] : [])),
			),
			open: canOpenTask ? openTask : undefined,
			openFile: canOpenFile ? openFile : undefined,
		}),
		[tasks, explorers, canOpenTask, canOpenFile, openTask, openFile],
	);
	// Keyed by the cell the main process resolved each checkpoint onto; ones that
	// have no cell (compacted away, or on an abandoned branch) only show in the
	// checkpoints panel.
	const checkpointByCell = useMemo(
		() =>
			new Map(
				(checkpoints ?? [])
					.filter((checkpoint) => checkpoint.cellId !== null)
					.map((checkpoint) => [checkpoint.cellId as string, checkpoint]),
			),
		[checkpoints],
	);
	let lastUserId: string | null = null;
	for (let i = cells.length - 1; i >= 0; i--) {
		if (cells[i].type === "user") {
			lastUserId = cells[i].id;
			break;
		}
	}
	// Scrolling the parent can re-render the chat surface without changing the
	// transcript. Keep this work tied to the structurally shared cell array so a
	// scroll event does not regroup every turn in a long session.
	const grouped = useMemo(() => groupTranscriptRows(cells), [cells]);
	const rows = useMemo(() => foldSettledTurns(grouped, streaming === true || settling), [grouped, streaming, settling]);
	const currentTurnRowIds = useMemo(() => {
		const start = rows.findIndex((row) => row.kind === "user" && row.cell.id === lastUserId);
		return new Set(start < 0 ? [] : rows.slice(start + 1).map((row) => row.id));
	}, [rows, lastUserId]);
	// Rebuilt as cells stream, but handed on only when a title actually changed:
	// every link in every answer reads this, and a new map per token would
	// re-render them all.
	const webTitlesRef = useRef<ReadonlyMap<string, string>>(new Map());
	const webTitles = useMemo(() => {
		const next = collectWebTitles(cells);
		const previous = webTitlesRef.current;
		if (next.size === previous.size && [...next].every(([key, title]) => previous.get(key) === title)) return previous;
		webTitlesRef.current = next;
		return next;
	}, [cells]);
	// A turn's edit summary hangs off its last row: the checkpoint that fronts the
	// turn already knows which files it changed, so the card only needs to know
	// where the turn ends. A following prompt settles that; at the tail nothing
	// does, so the card waits for the run to finish rather than appearing
	// half-written above an answer that is still arriving.
	const cardByRowId = useMemo(
		() => completedTurnChanges(rows, checkpoints ?? [], streaming === true || settling, composerCheckpointId),
		[rows, checkpoints, streaming, settling, composerCheckpointId],
	);
	// The reply each finished turn ends on: the next row is the next prompt, or
	// there is none and nothing is still running.
	const closingReplies = useMemo(() => {
		const ids = new Set<string>();
		for (let i = 0; i < rows.length; i++) {
			if (rows[i].kind !== "message") continue;
			const next = rows[i + 1];
			if (next === undefined ? streaming !== true : next.kind === "user") ids.add(rows[i].id);
		}
		return ids;
	}, [rows, streaming]);
	const waiting = waitingOnModel(cells, streaming === true);
	// An open run owns the wait: the line belongs to the work it is waiting on,
	// and only stands alone when nothing has been done in this turn yet.
	const waitingInWork = waiting && rows[rows.length - 1]?.kind === "work";
	return (
		<TaskLookupContext.Provider value={taskLookup}>
			<UsageModelsContext.Provider value={models ?? EMPTY_MODELS}>
			<CommandStopContext.Provider value={onStopCommand ? stopCommand : undefined}>
			<ToolOutputContext.Provider value={onLoadToolOutput}>
			<WebTitlesContext.Provider value={webTitles}>
			<div className="flex flex-col gap-4">
				{rows.map((row, index) => {
					const last = index === rows.length - 1;
					const card = cardByRowId.get(row.id);
					return (
						<div key={row.id} className={TRANSCRIPT_ROW_CLASS_NAME}>
							{row.kind === "user" ? (
								<UserCell
									cell={row.cell}
									anchor={row.cell.id === lastUserId}
									checkpoint={checkpointByCell.get(row.cell.id)}
									onRestore={onRestoreCheckpoint ? restoreCheckpoint : undefined}
									restoreDisabled={streaming === true}
								/>
							) : row.kind === "message" ? (
								<MessageCell
									cell={row.cell}
									closesTurn={closingReplies.has(row.id)}
									afterWork={closingReplies.has(row.id) && rows[index - 1]?.kind === "work"}
									onFork={onForkMessage ? forkMessage : undefined}
								/>
							) : row.kind === "thinking" ? (
								<CellThinking cell={row.cell} />
							) : row.kind === "notice" ? (
								<NoticeCell cell={row.cell} />
							) : (
								<WorkingBlock
									row={row}
									active={last && streaming === true}
									waiting={last && waitingInWork}
									settling={settling && currentTurnRowIds.has(row.id)}
								/>
							)}
							{card ? (
								<EditedFilesCard
									checkpoint={card}
									disabled={streaming === true}
									onRestore={onRestoreCheckpoint}
									onReview={onOpenReview}
									onOpenFile={onOpenFile}
								/>
							) : null}
						</div>
					);
				})}
				{waiting && !waitingInWork ? <PlanningLine /> : null}
			</div>
			</WebTitlesContext.Provider>
			</ToolOutputContext.Provider>
			</CommandStopContext.Provider>
			</UsageModelsContext.Provider>
		</TaskLookupContext.Provider>
	);
}

/**
 * The chat scroll container owns transient position state. Its updates should
 * not make React walk a long, unchanged transcript, so keep the whole view
 * out of that render path when the snapshot and handlers are unchanged.
 */
export const Transcript = memo(TranscriptView);
