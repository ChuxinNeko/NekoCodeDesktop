import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentCell } from "../../../shared/agent";
import { cn } from "../lib/utils";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, Loader2Icon, TriangleAlertIcon, HammerIcon } from "../lib/icons";
import { Spinner } from "./ui/spinner";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../surfaceStyles";

function Markdown({ text, user }: { text: string; user?: boolean }) {
	return (
		<div className={cn("chat-markdown", user && "chat-markdown--user")}>
			<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
		</div>
	);
}

/** Ticks once a second while `active` so elapsed-time labels stay current. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [active]);
	return now;
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function lastThinkingLine(thinking: string): string {
	const lines = thinking
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return lines[lines.length - 1] ?? "";
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

type AssistantCellData = Extract<AgentCell, { type: "assistant" }>;

/**
 * The thinking block, Codex-style: while the model reasons the header shimmers
 * "Thinking for Ns" with the latest line of reasoning underneath; once output
 * starts it settles to "Thought for Ns" and collapses to the header alone.
 * Reopened sessions carry no timing, so they read plain "Thought".
 */
function ThinkingBlock({ cell }: { cell: AssistantCellData }) {
	const [open, setOpen] = useState(false);
	const active = cell.streaming && cell.thinkingEndedAt === undefined;
	const now = useNow(active);
	const startedAt = cell.thinkingStartedAt ?? cell.timestamp;
	const end = active ? now : (cell.thinkingEndedAt ?? startedAt);
	const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
	const preview = lastThinkingLine(cell.thinking);
	const label = active
		? `Thinking for ${formatElapsed(seconds)}`
		: cell.thinkingEndedAt !== undefined
			? `Thought for ${formatElapsed(seconds)}`
			: "Thought";

	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className={cn(
					"inline-flex w-fit items-center gap-1 text-[length:var(--app-font-size-chat,12px)]",
					MUTED_LABEL_TEXT_CLASS_NAME,
				)}
			>
				{open ? (
					<ChevronDownIcon className="size-3.5" />
				) : (
					<ChevronRightIcon className="size-3.5" />
				)}
				<span className={active ? "shimmer" : undefined}>{label}</span>
			</button>
			{open ? (
				<pre className="whitespace-pre-wrap border-l border-border/60 pl-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
					{cell.thinking}
				</pre>
			) : active && preview ? (
				<div className="truncate border-l border-border/60 pl-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
					{preview}
				</div>
			) : null}
		</div>
	);
}

function AssistantCell({ cell }: { cell: AssistantCellData }) {
	return (
		<div className="flex w-full flex-col gap-2">
			{cell.thinking ? <ThinkingBlock cell={cell} /> : null}
			{cell.text ? <Markdown text={cell.text} /> : null}
			{cell.error ? (
				<div className="flex items-start gap-1.5 text-[length:var(--app-font-size-chat-meta,10px)] text-destructive">
					<CircleAlertIcon className="mt-px size-3.5 shrink-0" />
					<span>{cell.error}</span>
				</div>
			) : null}
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

function ToolCell({ cell }: { cell: Extract<AgentCell, { type: "tool" }> }) {
	const [open, setOpen] = useState(false);
	const argsText = toolArgsPreview(cell.args);
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
}: {
	cells: AgentCell[];
	streaming?: boolean;
}) {
	let lastUserId: string | null = null;
	for (let i = cells.length - 1; i >= 0; i--) {
		if (cells[i].type === "user") {
			lastUserId = cells[i].id;
			break;
		}
	}
	return (
		<div className="flex flex-col gap-4">
			{cells.map((cell) => {
				switch (cell.type) {
					case "user":
						return <UserCell key={cell.id} cell={cell} anchor={cell.id === lastUserId} />;
					case "assistant":
						return <AssistantCell key={cell.id} cell={cell} />;
					case "tool":
						return <ToolCell key={cell.id} cell={cell} />;
					case "notice":
						return <NoticeCell key={cell.id} cell={cell} />;
				}
			})}
			{waitingOnModel(cells, streaming === true) ? (
				<div
					className={cn(
						"text-[length:var(--app-font-size-chat,12px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					<span className="shimmer">Planning Next Step</span>
				</div>
			) : null}
		</div>
	);
}
