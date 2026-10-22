import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AssistantCellData, ToolCellData, WorkItem } from "../../../../shared/transcript";
import { useTranslation, type TranslateFn } from "../../i18n";
import { FileTypeIcon } from "../../lib/fileIcons";
import {
	AppsIcon,
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
	CameraIcon,
	ChevronRightIcon,
	CodeIcon,
	DesktopIcon,
	DownloadIcon,
	EyeIcon,
	FileIcon,
	FolderIcon,
	GitHubIcon,
	GlobeIcon,
	HammerIcon,
	KeyboardIcon,
	Loader2Icon,
	PencilIcon,
	PlayIcon,
	PointerIcon,
	SearchIcon,
	ServerIcon,
	TerminalIcon,
	TriangleAlertIcon,
	UploadIcon,
	WindowIcon,
	type LucideIcon,
} from "../../lib/icons";
import { cn } from "../../lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { Spinner } from "../ui/spinner";
import { DisclosureRegion } from "../ui/disclosure-region";
import { lastThinkingLine } from "./Thinking";
import { CommandStopButton } from "./CommandStopButton";

/**
 * Tool calls in the transcript, as one family.
 *
 * Every call is either a row or a card, and both are built from the same parts:
 * a status glyph in a fixed slot, a verb, what the call acted on, and the meta
 * that says how it went. A row is a call worth one line — a read, a search, a
 * listing — which unfolds into its output. A card is a call worth watching while
 * it runs: a command streaming its output, a run of desktop actions. Cards take
 * their motion from the Fast Context card — the scan line along the top edge
 * while working, steps popping in, a light sweep over the one still out — so
 * everything that works in the transcript moves the same way.
 */

// --- arguments ------------------------------------------------------------------

function argsOf(cell: ToolCellData): Record<string, unknown> {
	return typeof cell.args === "object" && cell.args !== null ? (cell.args as Record<string, unknown>) : {};
}

export function stringArg(cell: ToolCellData, key: string): string | null {
	const value = argsOf(cell)[key];
	return typeof value === "string" && value !== "" ? value : null;
}

function numberArg(cell: ToolCellData, key: string): number | null {
	const value = argsOf(cell)[key];
	return typeof value === "number" ? value : null;
}

function booleanArg(cell: ToolCellData, key: string): boolean {
	return argsOf(cell)[key] === true;
}

function stringListArg(cell: ToolCellData, key: string): string[] {
	const value = argsOf(cell)[key];
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "") : [];
}

function pathBasename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function clip(text: string, max = 48): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The arguments of a tool this file knows nothing about, as a person would read
 * them: the values, not the JSON around them.
 */
function argsSummary(cell: ToolCellData): string {
	if (typeof cell.args === "string") return cell.args;
	const entries = Object.entries(argsOf(cell));
	const values = entries
		.filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		.map(([, value]) => String(value))
		.filter(Boolean);
	if (values.length) return values.slice(0, 3).join(" · ");
	if (!entries.length) return "";
	try {
		return JSON.stringify(cell.args);
	} catch {
		return "";
	}
}

// --- status ---------------------------------------------------------------------

/**
 * Where a call stands, as the glyph shows it. `stopped` is a call left pending
 * or running by a run that is no longer going — an interrupted turn, reopened —
 * which must not spin forever.
 */
export type ToolPhase = "streaming" | "pending" | "running" | "done" | "error" | "stopped";

export function toolPhase(cell: ToolCellData, active: boolean): ToolPhase {
	if (cell.status === "error") return "error";
	if (cell.status === "done") return "done";
	if (!active) return "stopped";
	if (cell.inputStreaming) return "streaming";
	return cell.status;
}

function isLive(phase: ToolPhase): boolean {
	return phase === "streaming" || phase === "pending" || phase === "running";
}

/** True from the moment a call stops being live, so its glyph can settle once — never on history. */
function useJustSettled(live: boolean): boolean {
	const was = useRef(live);
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		if (was.current && !live) setSettled(true);
		was.current = live;
	}, [live]);
	return settled;
}

/** A clock in tenths while `active`: commands are measured in seconds, and "2s" held for a whole second looks stalled. */
function useTicker(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const id = window.setInterval(() => setNow(Date.now()), 100);
		return () => window.clearInterval(id);
	}, [active]);
	return now;
}

function formatDuration(ms: number): string {
	if (ms < 10_000) return `${(Math.max(ms, 0) / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** How long a call took, or has taken so far; null for history that kept no start. */
function callDuration(cell: ToolCellData, live: boolean, now: number): number | null {
	if (live) return now - (cell.startedAt ?? cell.timestamp);
	return cell.startedAt !== undefined ? cell.timestamp - cell.startedAt : null;
}

/** The fixed 16px slot every row and card header leads with. */
function ToolGlyph({ phase, icon: Icon, fileIconName }: { phase: ToolPhase; icon: LucideIcon; fileIconName?: string }) {
	const settled = useJustSettled(isLive(phase));
	return (
		<span
			// Remounted on each change of state, so the settle plays on the glyph
			// that replaced the spinner rather than on the spinner leaving.
			key={isLive(phase) ? "live" : phase}
			className={cn("inline-flex size-4 shrink-0 items-center justify-center", settled && "tool-settle")}
		>
			{phase === "running" || phase === "streaming" ? (
				<Spinner className="size-3.5 text-muted-foreground" />
			) : phase === "error" ? (
				<TriangleAlertIcon className="size-3.5 text-destructive" />
			) : fileIconName ? (
				<FileTypeIcon name={fileIconName} className={cn("size-3.5", phase === "pending" && "tool-breathe")} />
			) : (
				<Icon className={cn("size-3.5", MUTED_LABEL_TEXT_CLASS_NAME, phase === "pending" && "tool-breathe")} />
			)}
		</span>
	);
}

/**
 * The line every call is read by: glyph, verb, subject, meta, and — when there
 * is something to unfold — a chevron that turns as it opens. Used bare as a row
 * and as the header of a card, so the two can never drift apart.
 */
function ToolLine({
	phase,
	icon,
	fileIconName,
	label,
	subject,
	subjectMono = true,
	meta,
	expandable,
	open,
	title,
	onClick,
	className,
}: {
	phase: ToolPhase;
	icon: LucideIcon;
	fileIconName?: string;
	label: string;
	subject?: ReactNode;
	subjectMono?: boolean;
	meta?: ReactNode;
	/** Shows the chevron; a row that opens a file elsewhere has none. */
	expandable: boolean;
	open?: boolean;
	title?: string;
	onClick?: () => void;
	className?: string;
}) {
	return (
		<button
			type="button"
			aria-expanded={expandable ? open : undefined}
			title={title}
			onClick={onClick}
			disabled={!onClick}
			className={cn("tool-line group flex w-full min-w-0 items-center gap-1.5 text-left disabled:cursor-default", className)}
		>
			<ToolGlyph phase={phase} icon={icon} fileIconName={fileIconName} />
			<span
				className={cn(
					"shrink-0 text-[length:var(--app-font-size-chat,12px)] font-medium text-foreground/80 transition-colors group-hover:text-foreground",
				)}
			>
				{label}
			</span>
			{subject ? (
				<span
					className={cn(
						"min-w-0 truncate transition-colors group-hover:text-foreground/75",
						subjectMono
							? "font-mono text-[length:var(--app-font-size-ui-sm,11px)]"
							: "text-[length:var(--app-font-size-chat,12px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
						phase === "error" && "text-muted-foreground/70",
					)}
				>
					{subject}
				</span>
			) : null}
			{meta ? (
				<span
					className={cn(
						"ml-auto inline-flex shrink-0 items-center gap-1.5 pl-1 tabular-nums text-[length:var(--app-font-size-ui-sm,11px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					{meta}
				</span>
			) : null}
			{expandable ? (
				<ChevronRightIcon
					className={cn("tool-chevron size-3.5 shrink-0", !meta && "ml-auto", MUTED_LABEL_TEXT_CLASS_NAME)}
				/>
			) : meta ? (
				// Holds the chevron's place, so every row's meta lines up on one edge.
				<span aria-hidden="true" className="size-3.5 shrink-0" />
			) : null}
		</button>
	);
}

const CARD_CLASS_NAME = "relative overflow-hidden rounded-lg border border-border/60";
const CARD_HEADER_CLASS_NAME = "px-2.5 py-1.5";
const OUTPUT_SURFACE_CLASS_NAME = cn(
	"bg-[var(--color-token-text-code-block-background)]",
	"font-mono text-[length:var(--app-font-size-chat-code,11px)]",
);

// --- output ---------------------------------------------------------------------

/**
 * Fetch the rest of a tool result the transcript only carries the head of.
 *
 * A context because the rows that need it sit two levels inside a work group,
 * and only remote surfaces supply one at all — a local session already holds
 * every result in full.
 */
export const ToolOutputContext = createContext<
	((toolCallId: string, offset: number) => Promise<{ text: string; total: number }>) | undefined
>(undefined);

/** Character counts, in the units someone deciding whether to fetch cares about. */
function formatSize(chars: number): string {
	if (chars >= 1024 * 1024) return `${(chars / 1024 / 1024).toFixed(1)} MB`;
	return `${(Math.max(chars, 1) / 1024).toFixed(chars < 1024 ? 1 : 0)} KB`;
}

/** A call's output, joined with whatever of a trimmed remote result has been fetched since. */
function useToolOutput(cell: ToolCellData) {
	const load = useContext(ToolOutputContext);
	// Keyed by the head the transcript came with: a result still being written
	// replaces it, and what was read off the old one no longer joins onto it.
	const [fetched, setFetched] = useState<{ head: string; text: string } | null>(null);
	const [loading, setLoading] = useState(false);
	const shown = cell.output + (fetched?.head === cell.output ? fetched.text : "");
	const missing = cell.outputTotal === undefined ? 0 : cell.outputTotal - shown.length;
	const fetchMore = () => {
		if (!load || loading) return;
		const head = cell.output;
		setLoading(true);
		void load(cell.toolCallId, shown.length)
			.then((chunk) =>
				setFetched((previous) => ({ head, text: (previous?.head === head ? previous.text : "") + chunk.text })),
			)
			.catch(() => undefined)
			.finally(() => setLoading(false));
	};
	return { shown, missing, fetchMore, loading, canLoad: load !== undefined };
}

function MoreOutput({ output }: { output: ReturnType<typeof useToolOutput> }) {
	const { t } = useTranslation();
	if (output.missing <= 0) return null;
	return (
		<button
			type="button"
			className={cn(
				"flex w-full items-center justify-center gap-1.5 border-t border-border/40 px-2.5 py-1.5 font-sans",
				"text-[length:var(--app-font-size-ui-sm,11px)]",
				MUTED_LABEL_TEXT_CLASS_NAME,
				output.canLoad ? "hover:bg-[var(--color-background-elevated-secondary)]" : "cursor-default",
			)}
			disabled={!output.canLoad || output.loading}
			onClick={output.fetchMore}
		>
			{output.loading ? <Loader2Icon className="size-3 animate-spin" /> : null}
			{output.canLoad
				? t("transcript.outputRemaining", { size: formatSize(output.missing) })
				: t("transcript.outputTruncated", { size: formatSize(output.missing) })}
		</button>
	);
}

/**
 * A scrolling output pane that follows its tail while `live`, and lets go as
 * soon as the reader scrolls up — the same contract as the reasoning stream.
 */
function FollowingPre({ text, live, className, children }: { text: string; live: boolean; className?: string; children?: ReactNode }) {
	const ref = useRef<HTMLPreElement | null>(null);
	const follow = useRef(true);
	const wasLive = useRef(live);
	useLayoutEffect(() => {
		const el = ref.current;
		if (el && follow.current && (live || wasLive.current)) el.scrollTop = el.scrollHeight;
		wasLive.current = live;
	}, [text, live]);
	return (
		<pre
			ref={ref}
			onScroll={(event) => {
				const el = event.currentTarget;
				follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
			}}
			className={cn("overflow-auto overscroll-contain whitespace-pre-wrap break-words [overflow-wrap:anywhere]", className)}
		>
			{text}
			{children}
		</pre>
	);
}

// --- presentation ---------------------------------------------------------------

/**
 * How a row reads: a verb naming what the call did, the thing it did it to, and
 * where a click goes. A row with `openPath` sends the click to the dock's Files
 * pane instead of unfolding.
 */
interface ToolPresentation {
	label: string;
	subject: string | null;
	icon: LucideIcon;
	/** Prose, not code: set in the chat face rather than mono. */
	prose?: boolean;
	openPath?: string;
	/** The read row's glyph comes from the file's extension, not a fixed icon. */
	fileIconName?: string;
	meta?: string;
	title?: string;
	showArguments?: boolean;
}

function lineCount(text: string): number {
	return text.split("\n").filter((line) => line.trim()).length;
}

function toolPresentation(cell: ToolCellData, t: TranslateFn): ToolPresentation {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(cell.toolName);
	if (mcp) {
		const details = typeof cell.details === "object" && cell.details !== null ? cell.details as Record<string, unknown> : {};
		const server = typeof details.server === "string" && details.server.trim() ? details.server : mcp[1];
		const tool = typeof details.tool === "string" && details.tool.trim() ? details.tool : mcp[2];
		return { label: t("tool.mcpCalled"), subject: `${server} / ${tool}`, icon: ServerIcon,
			prose: true, title: cell.toolName, showArguments: true };
	}
	const settledOk = cell.status === "done";
	switch (cell.toolName) {
		case "read": {
			const path = stringArg(cell, "path");
			const offset = numberArg(cell, "offset");
			const limit = numberArg(cell, "limit");
			const meta =
				offset !== null && limit !== null
					? `L${offset}–${offset + limit - 1}`
					: offset !== null
						? `L${offset}+`
						: limit !== null
							? `L1–${limit}`
							: undefined;
			const basename = path ? pathBasename(path) : null;
			return {
				label: t("tool.read"),
				subject: basename ?? argsSummary(cell),
				icon: FileIcon,
				fileIconName: basename ?? undefined,
				openPath: path && cell.status !== "error" && !cell.inputStreaming ? path : undefined,
				meta,
			};
		}
		case "grep":
			return { label: t("tool.searched"), subject: stringArg(cell, "pattern") ?? argsSummary(cell), icon: SearchIcon };
		case "find":
			return {
				label: t("tool.foundFiles"),
				subject: stringArg(cell, "pattern") ?? argsSummary(cell),
				icon: SearchIcon,
				meta: settledOk ? t("toolCall.results", { count: lineCount(cell.output) }) : undefined,
			};
		case "ls":
			return {
				label: t("tool.listed"),
				subject: stringArg(cell, "path") ?? ".",
				icon: FolderIcon,
				meta: settledOk ? t("toolCall.entries", { count: lineCount(cell.output) }) : undefined,
			};
		case "stat": {
			const paths = stringListArg(cell, "paths");
			return {
				label: t("tool.measured"),
				subject:
					paths.length === 0
						? argsSummary(cell)
						: paths.length === 1
							? pathBasename(paths[0])
							: `${pathBasename(paths[0])} +${paths.length - 1}`,
				icon: FileIcon,
			};
		}
		case "semantic_search":
			return {
				label: t("tool.semanticSearched"),
				subject: stringArg(cell, "query") ?? argsSummary(cell),
				icon: SearchIcon,
				prose: true,
				meta: stringArg(cell, "path") ?? undefined,
			};
		case "ast_grep":
			return { label: t("tool.astSearched"), subject: stringArg(cell, "pattern") ?? argsSummary(cell), icon: CodeIcon };
		case "ast_edit":
			return {
				label: t(booleanArg(cell, "dryRun") ? "tool.astPreviewed" : "tool.astRewrote"),
				subject: stringArg(cell, "pattern") ?? argsSummary(cell),
				icon: CodeIcon,
			};
		case "github": {
			const number = numberArg(cell, "number");
			const run = numberArg(cell, "run");
			const detail =
				stringArg(cell, "query") ??
				stringArg(cell, "path") ??
				(number !== null ? `#${number}` : run !== null ? `run ${run}` : null);
			return {
				label: "GitHub",
				subject: [stringArg(cell, "repo"), stringArg(cell, "op"), detail].filter(Boolean).join(" · ") || argsSummary(cell),
				icon: GitHubIcon,
			};
		}
		case "web_search":
			return { label: t("tool.webSearched"), subject: stringArg(cell, "query") ?? argsSummary(cell), icon: SearchIcon, prose: true };
		case "web_fetch":
		case "browser_navigate": {
			const url = stringArg(cell, "url");
			return {
				label: t(cell.toolName === "web_fetch" ? "tool.webFetched" : "tool.browserOpened"),
				subject: url ? displayUrl(url) : argsSummary(cell),
				icon: GlobeIcon,
			};
		}
		case "browser_screenshot":
			return { label: t("tool.browserScreenshot"), subject: null, icon: CameraIcon };
		case "browser_evaluate":
			return { label: t("tool.browserEvaluated"), subject: firstLine(stringArg(cell, "script") ?? stringArg(cell, "expression")) ?? argsSummary(cell), icon: CodeIcon };
		case "browser_extract":
			return { label: t("tool.browserExtracted"), subject: argsSummary(cell) || null, icon: GlobeIcon };
		case "browser_viewport":
			return { label: t("tool.browserViewport"), subject: argsSummary(cell) || null, icon: WindowIcon };
		case "browser_action":
			return { label: t("tool.browserAction"), subject: argsSummary(cell) || null, icon: PointerIcon };
		case "ssh":
			return sshPresentation(cell, t);
		default:
			return { label: cell.toolName, subject: argsSummary(cell) || null, icon: HammerIcon };
	}
}

function firstLine(text: string | null): string | null {
	return text ? text.split("\n", 1)[0] : null;
}

function displayUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.host + parsed.pathname.replace(/\/$/, "");
	} catch {
		// Not a URL the model should have sent; show what it did send.
		return url;
	}
}

function sshHost(cell: ToolCellData): string | null {
	const fromDetails = (cell.details as { host?: unknown } | null | undefined)?.host;
	return stringArg(cell, "host") ?? (typeof fromDetails === "string" ? fromDetails : null);
}

/** The SSH ops that are not a command — those get the terminal card instead. */
function sshPresentation(cell: ToolCellData, t: TranslateFn): ToolPresentation {
	const host = sshHost(cell) ?? "ssh";
	const remote = stringArg(cell, "remote");
	const local = stringArg(cell, "local");
	switch (stringArg(cell, "op")) {
		case "hosts":
			return { label: t("tool.sshHosts"), subject: null, icon: ServerIcon };
		case "ls":
			return { label: t("tool.listed"), subject: `${host}:${remote ?? "."}`, icon: FolderIcon };
		case "upload":
			return { label: t("tool.sshUploaded"), subject: `${local ?? "?"} → ${host}:${remote ?? "?"}`, icon: UploadIcon };
		case "download":
			return { label: t("tool.sshDownloaded"), subject: `${host}:${remote ?? "?"} → ${local ?? "?"}`, icon: DownloadIcon };
		default:
			return { label: "SSH", subject: argsSummary(cell) || null, icon: ServerIcon };
	}
}

/** One line standing in for a call, for the header of a collapsed work group. */
export function toolSummary(cell: ToolCellData, t: TranslateFn): string {
	if (isShellTool(cell.toolName)) return `${t("tool.ranCommand")} ${firstLine(stringArg(cell, "command")) ?? ""}`.trim();
	if (cell.toolName === "ssh" && stringArg(cell, "op") === "exec")
		return `${t("tool.ranCommand")} ${firstLine(stringArg(cell, "command")) ?? ""}`.trim();
	if (isComputerTool(cell.toolName)) {
		const step = computerStep(cell, t);
		return `${step.verb} ${step.detail ?? ""}`.trim();
	}
	const presentation = toolPresentation(cell, t);
	return [presentation.label, presentation.subject].filter(Boolean).join(" ");
}

// --- rows -----------------------------------------------------------------------

function formattedArguments(args: unknown): string | null {
	if (args === null || args === undefined) return null;
	if (typeof args === "string") return args.trim() ? args : null;
	if (typeof args === "object" && Object.keys(args).length === 0) return null;
	try {
		return JSON.stringify(args, null, 2) ?? null;
	} catch {
		return null;
	}
}

/** A call worth one line: the line, and its output underneath once unfolded. */
const ToolRow = memo(function ToolRow({
	cell,
	active,
	onOpenFile,
}: {
	cell: ToolCellData;
	active: boolean;
	onOpenFile?: (path: string) => void;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const output = useToolOutput(cell);
	const phase = toolPhase(cell, active);
	const presentation = toolPresentation(cell, t);
	const argumentsText = presentation.showArguments ? formattedArguments(cell.args) : null;
	const opensFile = presentation.openPath !== undefined && onOpenFile !== undefined;
	const expandable = !opensFile && (output.shown !== "" || argumentsText !== null);

	return (
		<div className={cn("flex flex-col gap-1", active && "tool-enter")}>
			<ToolLine
				phase={phase}
				icon={presentation.icon}
				fileIconName={presentation.fileIconName}
				label={presentation.label}
				subject={presentation.subject}
				subjectMono={!presentation.prose}
				meta={presentation.meta}
				expandable={expandable}
				open={open}
				title={presentation.title ?? presentation.openPath ?? presentation.subject ?? undefined}
				onClick={
					opensFile
						? () => onOpenFile?.(presentation.openPath as string)
						: expandable
							? () => setOpen((value) => !value)
							: undefined
				}
				className="py-0.5"
			/>
			<DisclosureRegion open={open && expandable}>
				<div className={cn("ml-5.5 overflow-hidden rounded-lg border border-border/50", OUTPUT_SURFACE_CLASS_NAME)}>
					{argumentsText !== null ? <div className="border-b border-border/40 px-2.5 py-2">
						<div className="mb-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("toolCall.arguments")}</div>
						<pre className="max-h-48 overflow-auto overscroll-contain whitespace-pre-wrap break-words font-mono text-[length:var(--app-font-size-chat-code,11px)] text-foreground/85 [overflow-wrap:anywhere]">{argumentsText}</pre>
					</div> : null}
					{presentation.showArguments && (output.shown || output.missing > 0) ? <div className="px-2.5 pt-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("toolCall.result")}</div> : null}
					{output.shown ? <pre
						className={cn(
							"max-h-80 overflow-auto overscroll-contain whitespace-pre-wrap break-words px-2.5 py-2 [overflow-wrap:anywhere]",
							phase === "error" ? "text-destructive" : "text-foreground/85",
						)}
					>
						{output.shown}
					</pre> : null}
					<MoreOutput output={output} />
				</div>
			</DisclosureRegion>
		</div>
	);
});

// --- terminal -------------------------------------------------------------------

export function isShellTool(name: string): boolean {
	return name === "bash" || name === "powershell" || name === "cmd";
}

const SHELL_NAMES: Record<string, string> = { bash: "bash", powershell: "PowerShell", cmd: "cmd" };

interface CommandResult {
	/** The output with the status lines the tools append taken off; the header shows those. */
	body: string;
	exitCode: number | null;
	/** Why it stopped short of an exit code, when it did. */
	stopped: "timeout" | "aborted" | "killed" | null;
}

/**
 * Read the status a command tool appended to its output. The local shells add
 * a trailing "Command exited with code N"; the SSH tool leads with
 * "[host] exit code N" and splits the streams under markers.
 */
export function commandResult(output: string, ssh: boolean, status: ToolCellData["status"]): CommandResult {
	let body = output;
	let exitCode: number | null = null;
	let stopped: CommandResult["stopped"] = null;
	if (ssh) {
		const match = /^\[[^\]]*\] (.*)\n?/.exec(body);
		if (match) {
			body = body.slice(match[0].length);
			const code = /^exit code (\d+)/.exec(match[1]);
			if (code) exitCode = Number(code[1]);
			else if (match[1].startsWith("timed out")) stopped = "timeout";
			else if (match[1].startsWith("killed")) stopped = "killed";
		}
		body = body.replace(/^--- stdout ---\n/, "").replace(/^\(no output\)$/m, "");
	} else {
		if (body.startsWith("Command stopped by user.")) stopped = "aborted";
		const trailing = /\n*(Command exited with code (\d+)|Command timed out after \d+ seconds|Command aborted|Command terminated without an exit code)\s*$/.exec(body);
		if (trailing) {
			body = body.slice(0, trailing.index);
			if (trailing[2]) exitCode = Number(trailing[2]);
			else if (trailing[1].includes("timed out")) stopped = "timeout";
			else if (trailing[1].includes("aborted")) stopped = "aborted";
			else stopped = "killed";
		} else if (status === "done") {
			exitCode = 0;
		}
	}
	return { body: body.replace(/\s+$/, ""), exitCode, stopped };
}

/**
 * A command, local or on a saved SSH host, as a small terminal.
 *
 * While it runs the card opens onto its output and follows the tail, a caret
 * blinking where the next line lands and the scan line crossing the top edge.
 * Once it exits the card folds to its header — command, time, exit code — unless
 * the reader opened or closed it themselves, which it then leaves alone.
 */
const TerminalCard = memo(function TerminalCard({ cell, active }: { cell: ToolCellData; active: boolean }) {
	const { t } = useTranslation();
	const ssh = cell.toolName === "ssh";
	const command = stringArg(cell, "command") ?? "";
	const cwd = stringArg(cell, "cwd");
	const host = ssh ? sshHost(cell) : null;
	const phase = toolPhase(cell, active);
	const live = isLive(phase);
	const [manual, setManual] = useState<boolean | null>(null);
	const open = manual ?? live;
	const now = useTicker(live);
	const duration = callDuration(cell, live, now);
	const output = useToolOutput(cell);
	const result = commandResult(output.shown, ssh, cell.status);
	const failed = phase === "error" || (result.exitCode !== null && result.exitCode !== 0);

	const meta = (
		<>
			{result.stopped ? (
				<span className="text-[var(--warning)]">{t(`toolCall.${result.stopped}`)}</span>
			) : result.exitCode !== null && result.exitCode !== 0 ? (
				<span className="rounded bg-destructive/10 px-1 font-mono text-destructive">exit {result.exitCode}</span>
			) : null}
			{duration !== null ? <span>{formatDuration(duration)}</span> : null}
		</>
	);

	return (
		<div className={cn(CARD_CLASS_NAME, live && "tool-scan", active && "tool-enter")}>
			<div className="flex min-w-0 items-center">
			<ToolLine
				phase={failed && !live ? "error" : phase}
				icon={ssh ? ServerIcon : TerminalIcon}
				label={ssh ? (host ?? "SSH") : t("tool.ranCommand")}
				subject={firstLine(command) || (ssh ? stringArg(cell, "op") : null)}
				meta={meta}
				expandable
				open={open}
				title={command}
				onClick={() => setManual(!open)}
				className={cn(CARD_HEADER_CLASS_NAME, "flex-1")}
			/>
			{!ssh ? <CommandStopButton toolCallId={cell.toolCallId} running={phase === "running"} /> : null}
			</div>
			<DisclosureRegion open={open}>
				<div className={cn("border-t border-border/40", OUTPUT_SURFACE_CLASS_NAME)}>
					<div className="flex min-w-0 gap-2 px-2.5 pt-2 pb-1">
						<span className="shrink-0 select-none text-muted-foreground">
							{ssh ? `${host ?? "ssh"} $` : SHELL_NAMES[cell.toolName] === "PowerShell" ? "PS>" : cell.toolName === "cmd" ? ">" : "$"}
						</span>
						<span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
							{command}
							{cwd ? <span className="ml-2 text-muted-foreground/70">· {cwd}</span> : null}
						</span>
					</div>
					{result.body || live ? (
						<FollowingPre
							text={result.body}
							live={live}
							className={cn(
								"max-h-60 px-2.5 pb-2 text-foreground/80",
								live && result.body.split("\n").length > 12 && "tool-fade-top",
							)}
						>
							{live && !result.body ? (
								<span className="shimmer font-sans text-muted-foreground">{t("toolCall.waitingOutput")}</span>
							) : null}
							{phase === "running" ? <span aria-hidden="true" className="tool-caret" /> : null}
						</FollowingPre>
					) : (
						<div className="px-2.5 pb-2 font-sans text-muted-foreground/70">{t("toolCall.noOutput")}</div>
					)}
					<MoreOutput output={output} />
				</div>
			</DisclosureRegion>
		</div>
	);
});

// --- computer use ---------------------------------------------------------------

export function isComputerTool(name: string): boolean {
	return name.startsWith("computer_");
}

const KEY_NAMES: Record<string, string> = {
	ctrl: "Ctrl", control: "Ctrl", shift: "Shift", alt: "Alt", win: "Win", cmd: "Win", meta: "Win",
	return: "Enter", enter: "Enter", escape: "Esc", esc: "Esc", tab: "Tab", space: "Space",
	backspace: "Backspace", delete: "Del", up: "↑", down: "↓", left: "←", right: "→",
};

function keyLabel(key: string): string {
	const lower = key.trim().toLowerCase();
	return KEY_NAMES[lower] ?? (lower.length === 1 ? lower.toUpperCase() : lower.charAt(0).toUpperCase() + lower.slice(1));
}

const SCROLL_ICONS: Record<string, LucideIcon> = { up: ArrowUpIcon, down: ArrowDownIcon, left: ArrowLeftIcon, right: ArrowRightIcon };

/** One desktop action, the way the on-screen agent cursor labels it. */
function computerStep(cell: ToolCellData, t: TranslateFn): { icon: LucideIcon; verb: string; detail: string | null } {
	const named = stringArg(cell, "target");
	const element = numberArg(cell, "element_index");
	const x = numberArg(cell, "x");
	const y = numberArg(cell, "y");
	const target = named
		? `“${clip(named, 28)}”`
		: element !== null
			? `#${element}`
			: x !== null && y !== null
				? `(${Math.round(x)}, ${Math.round(y)})`
				: null;
	switch (cell.toolName) {
		case "computer_click": {
			const right = stringArg(cell, "button") === "right";
			const double = (numberArg(cell, "count") ?? 1) > 1;
			return {
				icon: PointerIcon,
				verb: t(right ? "computer.rightClick" : double ? "computer.doubleClick" : "computer.click"),
				detail: target,
			};
		}
		case "computer_type_text":
			return { icon: KeyboardIcon, verb: t("computer.type"), detail: `“${clip(stringArg(cell, "text") ?? "", 28)}”` };
		case "computer_press_key":
			return { icon: KeyboardIcon, verb: t("computer.key"), detail: stringListArg(cell, "keys").map(keyLabel).join("+") || null };
		case "computer_scroll": {
			const direction = stringArg(cell, "direction") ?? "down";
			return { icon: SCROLL_ICONS[direction] ?? ArrowDownIcon, verb: t("computer.scroll"), detail: target };
		}
		case "computer_set_value":
			return { icon: PencilIcon, verb: t("computer.setValue"), detail: `“${clip(stringArg(cell, "value") ?? "", 28)}”` };
		case "computer_drag":
			return { icon: ArrowRightIcon, verb: t("computer.drag"), detail: null };
		case "computer_screenshot":
			return { icon: CameraIcon, verb: t("computer.screenshot"), detail: null };
		case "computer_get_window_state": {
			const query = stringArg(cell, "query");
			return { icon: EyeIcon, verb: t("computer.readWindow"), detail: query ? `“${clip(query, 24)}”` : null };
		}
		case "computer_menu":
			return { icon: PointerIcon, verb: t("computer.menu"), detail: stringListArg(cell, "path").join(" › ") || null };
		case "computer_wait":
			return { icon: EyeIcon, verb: t("computer.wait"), detail: `“${clip(stringArg(cell, "text") ?? "", 24)}”` };
		case "computer_sequence": {
			const steps = (cell.args as { steps?: unknown } | undefined)?.steps;
			return { icon: PointerIcon, verb: t("computer.sequence"), detail: Array.isArray(steps) ? t("computer.steps", { count: steps.length }) : null };
		}
		case "computer_list_windows":
			return { icon: WindowIcon, verb: t("computer.listWindows"), detail: null };
		case "computer_list_apps":
			return { icon: AppsIcon, verb: t("computer.listApps"), detail: null };
		case "computer_launch_app": {
			const path = stringArg(cell, "path") ?? stringArg(cell, "launch_path");
			const name = stringArg(cell, "name") ?? (path ? pathBasename(path) : null) ?? stringArg(cell, "aumid") ?? stringListArg(cell, "urls")[0] ?? null;
			return { icon: PlayIcon, verb: t("computer.launch"), detail: name ? clip(name, 32) : null };
		}
		default:
			return { icon: DesktopIcon, verb: cell.toolName.replace(/^computer_/, ""), detail: null };
	}
}

export interface ComputerStepData {
	cell: ToolCellData;
	/** The reasoning that led to this action, when the model gave one. */
	thought?: AssistantCellData;
}

function ComputerChip({
	step,
	active,
	selected,
	onSelect,
}: {
	step: ComputerStepData;
	active: boolean;
	selected: boolean;
	onSelect: () => void;
}) {
	const { t } = useTranslation();
	const phase = toolPhase(step.cell, active);
	const view = computerStep(step.cell, t);
	const failed = phase === "error";
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-pressed={selected}
			title={failed && step.cell.output ? step.cell.output.split("\n", 1)[0] : undefined}
			className={cn(
				"relative inline-flex max-w-[16rem] min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5",
				"text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
				"bg-foreground/[0.04] hover:bg-[var(--color-background-elevated-secondary)]",
				selected && "ring-1 ring-border",
				active && "tool-pop",
				isLive(phase) && "tool-live",
				failed && "text-muted-foreground/60 line-through decoration-muted-foreground/40",
			)}
		>
			{failed ? <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-destructive/80" /> : null}
			<view.icon className={cn("size-3 shrink-0", MUTED_LABEL_TEXT_CLASS_NAME)} />
			<span className="shrink-0">{view.verb}</span>
			{view.detail ? <span className="min-w-0 truncate font-mono text-muted-foreground">{view.detail}</span> : null}
		</button>
	);
}

/**
 * A run of desktop actions as one card, the way Fast Context shows a search:
 * each action a chip that pops in as it is taken, the one in flight under a
 * light sweep, the latest reasoning underneath while it works. A chip opens
 * the action's result and the thought behind it.
 */
export const ComputerUseCard = memo(function ComputerUseCard({
	steps,
	active,
	pending,
}: {
	steps: ComputerStepData[];
	active: boolean;
	/** The model is reasoning toward its next action. */
	pending?: AssistantCellData;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(true);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const last = steps[steps.length - 1];
	const phases = steps.map((step) => toolPhase(step.cell, active));
	const live = phases.some(isLive);
	const now = useTicker(live);
	const startedAt = steps[0].thought?.thinkingStartedAt ?? steps[0].cell.startedAt ?? steps[0].cell.timestamp;
	const endedAt = live ? now : last.cell.timestamp;
	const failures = phases.filter((phase) => phase === "error").length;
	const current = computerStep(last.cell, t);
	const selected = steps.find((step) => step.cell.id === selectedId);
	const working = active && (live || pending !== undefined);
	// What the model is thinking now: toward the next action, or behind the one in flight.
	const reasoning = pending ? lastThinkingLine(pending.thinking) : live ? lastThinkingLine(last.thought?.thinking ?? "") : "";

	const meta = (
		<>
			{failures ? <span className="text-destructive">{t("computer.failed", { count: failures })}</span> : null}
			<span>{t("computer.steps", { count: steps.length })}</span>
			<span>{formatDuration(endedAt - startedAt)}</span>
		</>
	);

	return (
		<div className={cn(CARD_CLASS_NAME, working && "tool-scan", active && "tool-enter")}>
			<ToolLine
				phase={live ? "running" : phases.every((phase) => phase === "error") ? "error" : "done"}
				icon={DesktopIcon}
				label="Computer Use"
				subject={`${current.verb}${current.detail ? ` ${current.detail}` : ""}`}
				subjectMono={false}
				meta={meta}
				expandable
				open={open}
				onClick={() => setOpen((value) => !value)}
				className={CARD_HEADER_CLASS_NAME}
			/>
			<DisclosureRegion open={open}>
				<div className="flex flex-col gap-1.5 border-t border-border/40 px-2.5 py-2">
					<div className="flex min-w-0 flex-wrap gap-1">
						{steps.map((step) => (
							<ComputerChip
								key={step.cell.id}
								step={step}
								active={active}
								selected={step.cell.id === selectedId}
								onSelect={() => setSelectedId((id) => (id === step.cell.id ? null : step.cell.id))}
							/>
						))}
					</div>
					{reasoning && !selected ? (
						<span className="font-thinking truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
							{reasoning}
						</span>
					) : null}
					{selected ? <ComputerStepDetail step={selected} /> : null}
				</div>
			</DisclosureRegion>
		</div>
	);
});

function ComputerStepDetail({ step }: { step: ComputerStepData }) {
	const output = useToolOutput(step.cell);
	return (
		<div className="tool-expand flex flex-col gap-1.5">
			{step.thought?.thinking ? (
				<p className="font-thinking line-clamp-4 whitespace-pre-wrap border-l border-border/60 pl-2.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
					{step.thought.thinking.trim()}
				</p>
			) : null}
			{output.shown ? (
				<div className={cn("overflow-hidden rounded-md border border-border/50", OUTPUT_SURFACE_CLASS_NAME)}>
					<pre
						className={cn(
							"max-h-48 overflow-auto overscroll-contain whitespace-pre-wrap break-words px-2.5 py-2 [overflow-wrap:anywhere]",
							step.cell.status === "error" ? "text-destructive" : "text-foreground/80",
						)}
					>
						{output.shown}
					</pre>
					<MoreOutput output={output} />
				</div>
			) : null}
		</div>
	);
}

/** One entry of a work group once desktop actions are gathered into their card. */
export type WorkUnit =
	| { kind: "item"; item: WorkItem }
	| {
			kind: "computer";
			id: string;
			steps: ComputerStepData[];
			/** Reasoning at the tail of a live run: the action it is deciding on has not been taken yet. */
			pending?: AssistantCellData;
	  };

/**
 * Gather each run of desktop actions into one card. A thought between two
 * actions joins the card as the reason for the later one; a thought at the tail
 * of a live run is held there too, since the next action is what it is usually
 * about — it goes back to the group if something else follows instead.
 */
export function workUnits(items: WorkItem[], active: boolean, options: { inlineThinking?: boolean } = {}): WorkUnit[] {
	const units: WorkUnit[] = [];
	let held: Extract<WorkItem, { kind: "thinking" }>[] = [];
	const flush = () => {
		for (const item of held) units.push({ kind: "item", item });
		held = [];
	};
	for (const item of items) {
		const group = units[units.length - 1];
		if (item.kind === "tool" && isComputerTool(item.cell.toolName)) {
			// More than one thought between two actions is a change of course,
			// not the reason for the next click: it breaks the run.
			if (group?.kind === "computer" && held.length <= 1) {
				group.steps.push({ cell: item.cell, thought: held[0]?.cell });
				held = [];
			} else {
				flush();
				units.push({ kind: "computer", id: item.id, steps: [{ cell: item.cell }] });
			}
			continue;
		}
		if (item.kind === "thinking" && group?.kind === "computer" && !options.inlineThinking) {
			held.push(item);
			continue;
		}
		flush();
		units.push({ kind: "item", item });
	}
	const group = units[units.length - 1];
	if (active && group?.kind === "computer" && held.length === 1) {
		group.pending = held[0].cell;
		held = [];
	}
	flush();
	return units;
}

// --- dispatch -------------------------------------------------------------------

/**
 * Any tool call that is not one of the transcript's special cards (delegated
 * tasks, Fast Context, file edits): a command gets a terminal, the rest a row.
 */
export const ToolCall = memo(function ToolCall({
	cell,
	active,
	onOpenFile,
}: {
	cell: ToolCellData;
	active: boolean;
	onOpenFile?: (path: string) => void;
}) {
	if (isShellTool(cell.toolName) || (cell.toolName === "ssh" && stringArg(cell, "op") === "exec"))
		return <TerminalCard cell={cell} active={active} />;
	if (isComputerTool(cell.toolName)) return <ComputerUseCard steps={[{ cell }]} active={active} />;
	return <ToolRow cell={cell} active={active} onOpenFile={onOpenFile} />;
});

export { ToolGlyph, ToolLine, CARD_CLASS_NAME, CARD_HEADER_CLASS_NAME };
