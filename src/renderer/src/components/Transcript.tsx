import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import { highlightWhenIdle } from "../lib/codeHighlight";
import { TaskCard } from "./chat/AgentTask";
import { EditedFilesCard } from "./chat/EditedFilesCard";
import { lastThinkingLine, ThinkingBlock } from "./chat/Thinking";
import {
	MUTED_LABEL_TEXT_CLASS_NAME,
	SOFT_SURFACE_FILL_CLASS_NAME,
} from "../surfaceStyles";

// Parsing is the dearest thing a transcript row does, and a long session has
// hundreds of rows: only a message whose text actually changed re-parses.
const Markdown = memo(function Markdown({ text, user }: { text: string; user?: boolean }) {
	return (
		<div className={cn("chat-markdown", user && "chat-markdown--user")}>
			<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
		</div>
	);
});

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
 */
const MessageCell = memo(function MessageCell({ cell }: { cell: AssistantCellData }) {
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
});

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
 * Fetch the rest of a tool result the transcript only carries the head of.
 *
 * A context for the same reason as {@link TaskLookupContext}: the tool row sits
 * two levels inside a work group, and only remote surfaces supply one at all —
 * a local session already holds every result in full.
 */
const ToolOutputContext = createContext<
	((toolCallId: string, offset: number) => Promise<{ text: string; total: number }>) | undefined
>(undefined);

/**
 * The worker a `task` call started, if it is still known.
 *
 * The id comes back in the tool's own result, which is the only thing tying the
 * transcript row to the live worker — the row is a record of the request, the
 * worker is the thing still running.
 */
/** Character counts, in the units someone deciding whether to fetch cares about. */
function formatSize(chars: number): string {
	if (chars >= 1024 * 1024) return `${(chars / 1024 / 1024).toFixed(1)} MB`;
	return `${(Math.max(chars, 1) / 1024).toFixed(chars < 1024 ? 1 : 0)} KB`;
}

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
	}, [seen]);

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
		case "powershell":
		case "cmd": {
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

const ToolCell = memo(function ToolCell({ cell, active }: { cell: Extract<AgentCell, { type: "tool" }>; active: boolean }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const view = useContext(TaskLookupContext);
	const loadOutput = useContext(ToolOutputContext);
	// What has been fetched beyond the head the transcript came with. Keyed by
	// that head: a result still being written replaces it, and what was read off
	// the old one no longer joins onto it.
	const [fetched, setFetched] = useState<{ head: string; text: string } | null>(null);
	const [loadingOutput, setLoadingOutput] = useState(false);
	const extra = fetched?.head === cell.output ? fetched.text : "";
	const shown = cell.output + extra;
	const missing = cell.outputTotal === undefined ? 0 : cell.outputTotal - shown.length;
	const fetchMore = () => {
		if (!loadOutput || loadingOutput) return;
		const head = cell.output;
		setLoadingOutput(true);
		void loadOutput(cell.toolCallId, shown.length)
			.then((chunk) => {
				setFetched((previous) => ({
					head,
					text: (previous?.head === head ? previous.text : "") + chunk.text,
				}));
			})
			.catch(() => undefined)
			.finally(() => setLoadingOutput(false));
	};

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
					{shown ? (
						<pre className="max-h-80 overflow-auto whitespace-pre-wrap p-2.5">
							{shown}
						</pre>
					) : null}
					{missing > 0 ? (
						<button
							type="button"
							className={cn(
								"flex w-full items-center justify-center gap-1.5 border-t border-border/60 px-2.5 py-1.5",
								"text-[length:var(--app-font-size-ui-sm,11px)]",
								MUTED_LABEL_TEXT_CLASS_NAME,
								loadOutput ? "hover:bg-[var(--color-background-elevated-secondary)]" : "cursor-default",
							)}
							disabled={!loadOutput || loadingOutput}
							onClick={fetchMore}
						>
							{loadingOutput ? <Loader2Icon className="size-3 animate-spin" /> : null}
							{loadOutput
								? t("transcript.outputRemaining", { size: formatSize(missing) })
								: t("transcript.outputTruncated", { size: formatSize(missing) })}
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
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
	prev: { row: WorkRow; active: boolean; waiting: boolean },
	next: { row: WorkRow; active: boolean; waiting: boolean },
): boolean {
	if (prev.active !== next.active || prev.waiting !== next.waiting) return false;
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
 * answer they were for scrolls off the top before it is read. Open by default —
 * watching the work is the point while it runs — but one click puts a whole
 * run behind a single line, which is what makes a finished transcript
 * readable. The header sits a step above "Thinking for" in size because it
 * contains it.
 */
const WorkingBlock = memo(function WorkingBlock({
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

const TranscriptView = function Transcript({
	cells,
	streaming,
	tasks,
	onOpenTask,
	onOpenFile,
	checkpoints,
	onRestoreCheckpoint,
	onOpenReview,
	onLoadToolOutput,
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
	/**
	 * Fetch the rest of a trimmed tool result. Only remote surfaces pass one; a
	 * local transcript already holds every result whole.
	 */
	onLoadToolOutput?: (toolCallId: string, offset: number) => Promise<{ text: string; total: number }>;
}) {
	// The handlers come from parents that recreate them every render. Reached
	// through a ref, they stop being a reason for every row to re-render: the
	// context value and the memoized rows only change with what they show.
	const handlers = useRef({ onOpenTask, onOpenFile, onRestoreCheckpoint });
	handlers.current = { onOpenTask, onOpenFile, onRestoreCheckpoint };
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
			open: canOpenTask ? openTask : undefined,
			openFile: canOpenFile ? openFile : undefined,
		}),
		[tasks, canOpenTask, canOpenFile, openTask, openFile],
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
	const rows = useMemo(() => groupTranscriptRows(cells), [cells]);
	// A turn's edit summary hangs off its last row: the checkpoint that fronts the
	// turn already knows which files it changed, so the card only needs to know
	// where the turn ends. A following prompt settles that; at the tail nothing
	// does, so the card waits for the run to finish rather than appearing
	// half-written above an answer that is still arriving.
	const cardByRowId = useMemo(() => {
		const cards = new Map<string, CheckpointSummary>();
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
				cards.set(row.id, turnCheckpoint);
			}
		}
		return cards;
	}, [rows, checkpointByCell, streaming]);
	const waiting = waitingOnModel(cells, streaming === true);
	// An open run owns the wait: the line belongs to the work it is waiting on,
	// and only stands alone when nothing has been done in this turn yet.
	const waitingInWork = waiting && rows[rows.length - 1]?.kind === "work";
	return (
		<TaskLookupContext.Provider value={taskLookup}>
			<ToolOutputContext.Provider value={onLoadToolOutput}>
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
						</div>
					);
				})}
				{waiting && !waitingInWork ? <PlanningLine /> : null}
			</div>
			</ToolOutputContext.Provider>
		</TaskLookupContext.Provider>
	);
}

/**
 * The chat scroll container owns transient position state. Its updates should
 * not make React walk a long, unchanged transcript, so keep the whole view
 * out of that render path when the snapshot and handlers are unchanged.
 */
export const Transcript = memo(TranscriptView);
