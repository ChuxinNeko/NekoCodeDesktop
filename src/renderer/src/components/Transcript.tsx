import { useState } from "react";
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

function UserCell({ cell }: { cell: Extract<AgentCell, { type: "user" }> }) {
	return (
		<div className="flex w-full justify-end">
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

function AssistantCell({ cell }: { cell: Extract<AgentCell, { type: "assistant" }> }) {
	const [thinkingOpen, setThinkingOpen] = useState(false);
	return (
		<div className="flex w-full flex-col gap-2">
			{cell.thinking ? (
				<div className="flex flex-col gap-1">
					<button
						type="button"
						onClick={() => setThinkingOpen((open) => !open)}
						className={cn(
							"inline-flex w-fit items-center gap-1 text-[length:var(--app-font-size-chat-meta,10px)]",
							MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						{thinkingOpen ? (
							<ChevronDownIcon className="size-3" />
						) : (
							<ChevronRightIcon className="size-3" />
						)}
						Thinking
					</button>
					{thinkingOpen ? (
						<pre className="whitespace-pre-wrap border-l border-border/60 pl-3 text-[length:var(--app-font-size-chat-meta,10px)] text-muted-foreground/70">
							{cell.thinking}
						</pre>
					) : null}
				</div>
			) : null}
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
					<Spinner className="size-3 text-muted-foreground" />
				) : cell.status === "error" ? (
					<TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />
				) : (
					<HammerIcon className={cn("size-3.5 shrink-0", MUTED_LABEL_TEXT_CLASS_NAME)} />
				)}
				<span className="shrink-0 text-[length:var(--app-font-size-chat,12px)] font-medium">
					{cell.toolName}
				</span>
				{argsText ? (
					<span className={cn("min-w-0 flex-1 truncate font-mono text-[length:var(--app-font-size-chat-meta,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
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

export function Transcript({ cells }: { cells: AgentCell[] }) {
	return (
		<div className="flex flex-col gap-4">
			{cells.map((cell) => {
				switch (cell.type) {
					case "user":
						return <UserCell key={cell.id} cell={cell} />;
					case "assistant":
						return <AssistantCell key={cell.id} cell={cell} />;
					case "tool":
						return <ToolCell key={cell.id} cell={cell} />;
					case "notice":
						return <NoticeCell key={cell.id} cell={cell} />;
				}
			})}
		</div>
	);
}
