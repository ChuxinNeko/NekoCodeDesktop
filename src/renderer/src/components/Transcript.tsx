import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ThinkingOrb } from "thinking-orbs";
import type { AgentCell } from "../../../shared/agent";
import type { CheckpointSummary } from "../../../shared/checkpoints";
import type { WorkflowTask } from "../../../shared/workflow";
import {
	groupTranscriptRows,
	workToolCount,
	type AssistantCellData,
	type WorkItem,
	type WorkRow,
} from "../../../shared/transcript";
import { UsagePanel } from "./chat/UsagePanel";
import { useTranslation, type TranslationKey } from "../i18n";
import { elapsedSeconds, formatElapsed, useNow } from "../lib/elapsed";
import { cn } from "../lib/utils";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, FileIcon, FolderIcon, Loader2Icon, SearchIcon, TerminalIcon, TriangleAlertIcon, HammerIcon, Undo2Icon } from "../lib/icons";
import { Spinner } from "./ui/spinner";
import { FileTypeIcon } from "../lib/fileIcons";
import { highlightFileToHtml } from "../lib/codeHighlight";
import { TaskCard } from "./chat/AgentTask";
import { EditedFilesCard } from "./chat/EditedFilesCard";
import { lastThinkingLine, ThinkingBlock } from "./chat/Thinking";
import {
	MUTED_LABEL_TEXT_CLASS_NAME,
	SOFT_SURFACE_FILL_CLASS_NAME,
} from "../surfaceStyles";

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
	}, [code, live]);

	useEffect(() => {
		let cancelled = false;
		setHighlighted(null);
		// Do not re-tokenize the entire growing file on every input delta.
		// Plain text arrives immediately; syntax colors settle with the input.
		if (cell.inputStreaming) return;
		highlightFileToHtml(code, preview.path)
			.then((html) => {
				if (cancelled || !html) return;
				const doc = new DOMParser().parseFromString(html, "text/html");
				const spans = Array.from(doc.querySelectorAll(".line"));
				setHighlighted({ code, path: preview.path, lines: spans.map((node) => node.innerHTML) });
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [code, preview.path, cell.inputStreaming]);

	const basename = preview.path.split(/[\\/]/).pop() || t(cell.toolName === "write" ? "fileEdit.write" : "fileEdit.edit");
	const additions = lines.filter((line) => line.kind === "add").length;
	const deletions = lines.filter((line) => line.kind === "remove").length;
	const phase = cell.inputStreaming
		? t("fileEdit.generating")
		: cell.status === "running"
			? t("fileEdit.applying")
			: cell.status === "pending" ? t("fileEdit.pending") : null;

	return (
		<div data-file-edit={cell.toolCallId} className="overflow-hidden rounded-xl border border-border/60">
			<div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
				<FileTypeIcon name={basename} className="size-3.5 shrink-0" />
				{cell.inputStreaming || cell.status === "running" ? (
					<Spinner className="size-3 shrink-0 text-muted-foreground" />
				) : null}
				<span
					className="min-w-0 flex-1 truncate font-mono text-[length:var(--app-font-size-ui-sm,11px)]"
					title={preview.path}
				>
					{basename}
				</span>
				{phase ? <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{phase}</span> : null}
				<span className="inline-flex shrink-0 items-center gap-1 tabular-nums text-[length:var(--app-font-size-ui-xs,10px)]">
					{additions > 0 ? (
						<span className="text-success">+{additions.toLocaleString()}</span>
					) : null}
					{deletions > 0 ? (
						<span className="text-destructive">−{deletions.toLocaleString()}</span>
					) : null}
				</span>
			</div>
			<div
				ref={bodyRef}
				onScroll={(event) => {
					const body = event.currentTarget;
					followRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
				}}
				className="max-h-64 overflow-auto font-mono text-[length:var(--app-font-size-chat-code,11px)]"
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
		</div>
	);
}

function toolStringArg(cell: Extract<AgentCell, { type: "tool" }>, key: string): string | null {
	const args =
		typeof cell.args === "object" && cell.args !== null
			? (cell.args as Record<string, unknown>)
			: null;
	const value = args?.[key];
	return typeof value === "string" && value !== "" ? value : null;
}

function toolStringListArg(cell: Extract<AgentCell, { type: "tool" }>, key: string): string[] {
	const args =
		typeof cell.args === "object" && cell.args !== null
			? (cell.args as Record<string, unknown>)
			: null;
	const value = args?.[key];
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
		: [];
}

function pathBasename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * How one tool call presents in the transcript, Codex-style: a past-tense verb
 * naming what the call did, the thing it did it to trailing in mono, and where
 * the row's click goes. Rows with a `command` echo it above the output when
 * unfolded; a row with `openPath` sends the click to the dock's Files pane
 * instead of unfolding.
 */
interface ToolPresentation {
	label: string;
	subject: string | null;
	icon: typeof HammerIcon;
	openPath?: string;
	command?: string;
	/** The read row's glyph comes from the file's extension, not a fixed icon. */
	fileIconName?: string;
}

function toolPresentation(
	cell: Extract<AgentCell, { type: "tool" }>,
	t: (key: TranslationKey) => string,
): ToolPresentation {
	const argsText = toolArgsPreview(cell.args);
	switch (cell.toolName) {
		case "read": {
			const path = toolStringArg(cell, "path");
			if (path && cell.status !== "error" && !cell.inputStreaming) {
				const basename = pathBasename(path);
				return {
					label: t("tool.read"),
					subject: basename,
					icon: FileIcon,
					fileIconName: basename,
					openPath: path,
				};
			}
			return { label: t("tool.read"), subject: path ?? argsText, icon: FileIcon };
		}
		case "bash":
		case "powershell": {
			const command = toolStringArg(cell, "command");
			return {
				label: t("tool.ranCommand"),
				subject: command?.split("\n", 1)[0] ?? argsText,
				icon: TerminalIcon,
				command: command ?? undefined,
			};
		}
		case "grep":
			return {
				label: t("tool.searched"),
				subject: toolStringArg(cell, "pattern") ?? argsText,
				icon: SearchIcon,
			};
		case "find":
			return {
				label: t("tool.foundFiles"),
				subject: toolStringArg(cell, "pattern") ?? argsText,
				icon: SearchIcon,
			};
		case "ls":
			return {
				label: t("tool.listed"),
				subject: toolStringArg(cell, "path") ?? ".",
				icon: FolderIcon,
			};
		case "stat": {
			const paths = toolStringListArg(cell, "paths");
			return {
				label: t("tool.measured"),
				subject:
					paths.length === 0
						? argsText
						: paths.length === 1
							? pathBasename(paths[0])
							: `${pathBasename(paths[0])} +${paths.length - 1}`,
				icon: FileIcon,
			};
		}
		default:
			return { label: cell.toolName, subject: argsText, icon: HammerIcon };
	}
}

function ToolCell({ cell, active }: { cell: Extract<AgentCell, { type: "tool" }>; active: boolean }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const view = useContext(TaskLookupContext);

	// A delegation is not a tool result to unfold — it is a whole session that
	// ran, so the row shows the worker itself rather than the JSON acknowledging
	// that one started.
	const id = taskIdOf(cell);
	const task = id ? view.tasks.get(id) : undefined;
	if (task) return <TaskCard task={task} onOpen={view.open} />;

	const fileEdit = cell.status === "error" ? null : fileEditPreview(cell);
	if (fileEdit) return <FileEditCell cell={cell} preview={fileEdit} active={active} />;

	const presentation = toolPresentation(cell, t);
	const opensFile = presentation.openPath !== undefined && view.openFile !== undefined;

	const hasChip = presentation.subject !== null;

	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				aria-expanded={opensFile ? undefined : open}
				title={presentation.openPath ?? presentation.subject ?? undefined}
				onClick={() =>
					opensFile
						? view.openFile?.(presentation.openPath as string)
						: setOpen((value) => !value)
				}
				className="group flex w-full items-center gap-1.5 py-0.5 text-left"
			>
				{cell.status === "running" ? (
					<Spinner className="size-3.5 shrink-0 text-muted-foreground" />
				) : cell.status === "error" ? (
					<TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />
				) : hasChip ? null : (
					<presentation.icon
						className={cn("size-3.5 shrink-0", MUTED_LABEL_TEXT_CLASS_NAME)}
					/>
				)}
				<span className="shrink-0 text-[length:var(--app-font-size-chat,12px)] font-medium">
					{presentation.label}
				</span>
				{/* The tinted box carries what the call acted on — icon plus name —
				    while the verb stays outside it, the way Codex reads the row. */}
				{hasChip ? (
					<span
						className={cn(
							"inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors",
							SOFT_SURFACE_FILL_CLASS_NAME,
							"group-hover:bg-[var(--color-background-elevated-secondary)]",
						)}
					>
						{presentation.fileIconName ? (
							<FileTypeIcon name={presentation.fileIconName} className="size-3.5 shrink-0" />
						) : (
							<presentation.icon
								className={cn("size-3.5 shrink-0", MUTED_LABEL_TEXT_CLASS_NAME)}
							/>
						)}
						<span className="truncate font-mono text-[length:var(--app-font-size-ui-sm,11px)]">
							{presentation.subject}
						</span>
					</span>
				) : null}
				<span className="flex-1" />
				{cell.status === "pending" ? (
					<Loader2Icon className="size-3 shrink-0 opacity-40" />
				) : null}
			</button>
			{open && (presentation.command || cell.output) ? (
				<div
					className={cn(
						"overflow-hidden rounded-lg border border-border/60",
						"bg-[var(--color-token-text-code-block-background)]",
						"font-mono text-[length:var(--app-font-size-chat-code,11px)]",
					)}
				>
					{presentation.command ? (
						<div className="whitespace-pre-wrap break-words border-b border-border/60 px-2.5 py-1.5 [overflow-wrap:anywhere]">
							{presentation.command}
						</div>
					) : null}
					{cell.output ? (
						<pre className="max-h-80 overflow-auto whitespace-pre-wrap p-2.5">
							{cell.output}
						</pre>
					) : null}
				</div>
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
				{active ? <ThinkingOrb state="solving" size={20} /> : null}
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
							<ToolCell key={item.id} cell={item.cell} active={active} />
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
	onOpenFile,
	checkpoints,
	onRestoreCheckpoint,
	onOpenReview,
}: {
	cells: AgentCell[];
	streaming?: boolean;
	/** Background workers, so a `task` row can show the worker it started. */
	tasks?: WorkflowTask[];
	onOpenTask?: (taskId: string) => void;
	/** Show a file a tool row references in the dock's Files pane. */
	onOpenFile?: (path: string) => void;
	/** Restore points, so a prompt can offer the rewind of its own turn. */
	checkpoints?: readonly CheckpointSummary[];
	onRestoreCheckpoint?: (checkpoint: CheckpointSummary) => void;
	/** Open the review panel — the edit summary card's "Review" action. */
	onOpenReview?: () => void;
}) {
	const taskLookup = useMemo<TaskView>(
		() => ({
			tasks: new Map((tasks ?? []).map((task) => [task.id, task])),
			open: onOpenTask,
			openFile: onOpenFile,
		}),
		[tasks, onOpenTask, onOpenFile],
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
	const rows = groupTranscriptRows(cells);
	// A turn's edit summary hangs off its last row: the checkpoint that fronts the
	// turn already knows which files it changed, so the card only needs to know
	// where the turn ends. A following prompt settles that; at the tail nothing
	// does, so the card waits for the run to finish rather than appearing
	// half-written above an answer that is still arriving.
	const cardByRowId = new Map<string, CheckpointSummary>();
	let turnCheckpoint: CheckpointSummary | undefined;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row.kind === "user") {
			turnCheckpoint = checkpointByCell.get(row.cell.id);
			continue;
		}
		const next = rows[i + 1];
		const turnEnded = next === undefined ? streaming !== true : next.kind === "user";
		if (turnEnded && turnCheckpoint !== undefined && turnCheckpoint.fileCount > 0) {
			cardByRowId.set(row.id, turnCheckpoint);
		}
	}
	const waiting = waitingOnModel(cells, streaming === true);
	// An open run owns the wait: the line belongs to the work it is waiting on,
	// and only stands alone when nothing has been done in this turn yet.
	const waitingInWork = waiting && rows[rows.length - 1]?.kind === "work";
	return (
		<TaskLookupContext.Provider value={taskLookup}>
			<div className="flex flex-col gap-4">
				{rows.map((row, index) => {
					const last = index === rows.length - 1;
					const card = cardByRowId.get(row.id);
					return (
						<Fragment key={row.id}>
							{row.kind === "user" ? (
								<UserCell
									cell={row.cell}
									anchor={row.cell.id === lastUserId}
									checkpoint={checkpointByCell.get(row.cell.id)}
									onRestore={onRestoreCheckpoint}
									restoreDisabled={streaming === true}
								/>
							) : row.kind === "message" ? (
								<MessageCell cell={row.cell} />
							) : row.kind === "thinking" ? (
								<CellThinking cell={row.cell} />
							) : row.kind === "notice" ? (
								<NoticeCell cell={row.cell} />
							) : (
								<WorkingBlock
									row={row}
									active={last && streaming === true}
									waiting={last && waitingInWork}
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
						</Fragment>
					);
				})}
				{waiting && !waitingInWork ? <PlanningLine /> : null}
			</div>
		</TaskLookupContext.Provider>
	);
}
