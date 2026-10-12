import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TaskStep, WorkflowTask } from "../../../../shared/workflow";
import type { ToolCellData } from "../../../../shared/transcript";
import { useTranslation, type TranslationKey } from "../../i18n";
import { elapsedSeconds, formatElapsed, useNow } from "../../lib/elapsed";
import { ArrowDownIcon, BotIcon, HammerIcon, TerminalIcon, TriangleAlertIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { ThinkingBlock } from "../chat/Thinking";
import { Markdown } from "../chat/Markdown";
import { isShellTool, ToolCall, ToolLine, toolPhase } from "../chat/ToolCalls";
import { CommandStopButton } from "../chat/CommandStopButton";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";

const STATUS_KEYS: Record<WorkflowTask["status"], TranslationKey> = {
	running: "workflow.running",
	completed: "workflow.completed",
	failed: "workflow.failed",
	cancelled: "workflow.cancelled",
};

const KIND_KEYS: Record<WorkflowTask["kind"], TranslationKey> = {
	explore: "workflow.taskKind.explore",
	worker: "workflow.taskKind.worker",
};

/** Adapt bounded worker previews to the main transcript's presentation contract. */
function toolCell(step: Extract<TaskStep, { kind: "tool" }>): ToolCellData {
	let args: unknown = step.args;
	try { args = JSON.parse(step.args); } catch { /* A retained preview can be truncated JSON. */ }
	if (isShellTool(step.toolName) && typeof args === "string" && !args.trimStart().startsWith("{"))
		args = { command: args };
	return { id: step.id, type: "tool", toolCallId: step.id, toolName: step.toolName,
		args, output: step.output ?? "", status: step.status, startedAt: step.startedAt,
		timestamp: step.endedAt ?? step.startedAt };
}

/** Keep truncated JSON as a preview, never pretend it is a complete shell command. */
function PreviewTool({ cell, step, active }: { cell: ToolCellData; step: Extract<TaskStep, { kind: "tool" }>; active: boolean }) {
	const [manual, setManual] = useState<boolean | null>(null);
	const open = manual ?? step.status === "error";
	const now = useNow(active && step.status === "running");
	const seconds = elapsedSeconds(step.startedAt, step.endedAt ?? (active ? now : step.startedAt));
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<div className="flex min-w-0 items-center">
			<ToolLine phase={toolPhase(cell, active)} icon={isShellTool(step.toolName) ? TerminalIcon : HammerIcon}
				label={step.toolName} subject={step.args} title={step.args}
				meta={seconds > 0 ? formatElapsed(seconds) : undefined}
				expandable={!!step.output} open={open}
				onClick={step.output ? () => setManual(!open) : undefined} className="flex-1 py-0.5" />
			{isShellTool(step.toolName) ? <CommandStopButton toolCallId={cell.toolCallId} running={active && step.status === "running"} /> : null}
			</div>
			{open && step.output ? (
				<pre className={cn("tool-expand ml-5.5 max-h-80 overflow-auto overscroll-contain rounded-lg border border-border/50",
					"bg-[var(--color-token-text-code-block-background)] px-2.5 py-2 font-mono text-[length:var(--app-font-size-chat-code,11px)]",
					"whitespace-pre-wrap break-words [overflow-wrap:anywhere]", step.status === "error" && "text-destructive")}>
					{step.output}
				</pre>
			) : null}
		</div>
	);
}

function ToolStep({ step, active }: { step: Extract<TaskStep, { kind: "tool" }>; active: boolean }) {
	const cell = useMemo(() => toolCell(step), [step]);
	return typeof cell.args === "string" && cell.args.trimStart().startsWith("{")
		? <PreviewTool cell={cell} step={step} active={active} />
		: <ToolCall cell={cell} active={active} />;
}

function MessageStep({ step }: { step: Extract<TaskStep, { kind: "message" }> }) {
	return <div className="min-w-0 py-1"><Markdown text={step.text} /></div>;
}

/**
 * One background worker's whole run, in the dock.
 *
 * The compact card in the transcript answers "is it still going"; this answers
 * "what is it doing" — every call with its arguments and output, interleaved
 * with what the worker said. It follows the tail while the worker runs, and
 * gives that up the moment the reader scrolls away from the bottom, because a
 * panel that yanks you back is worse than one that stops moving.
 */
export function TaskDetailPanel({
	task,
	onCancel,
}: {
	task: WorkflowTask | null;
	onCancel?: (id: string) => void;
}) {
	const { t } = useTranslation();
	const scrollRef = useRef<HTMLDivElement>(null);
	const followRef = useRef(true);
	const [following, setFollowing] = useState(true);
	const running = task?.status === "running";
	const now = useNow(running);
	const stepCount = task?.steps.length ?? 0;
	// Reasoning grows in place without adding a step, so the count alone would
	// stop following the tail exactly while there is most to follow.
	const tail = task?.steps[stepCount - 1];
	const tailSize = tail ? (tail.kind === "tool" ? (tail.output?.length ?? 0) : tail.text.length) : 0;

	useLayoutEffect(() => {
		followRef.current = true;
		setFollowing(true);
	}, [task?.id]);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el || !followRef.current) return;
		el.scrollTop = el.scrollHeight;
	}, [stepCount, tailSize, task?.status, task?.id, task?.result]);

	if (!task) {
		return (
			<p className={cn("p-3 text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
				{t("workflow.taskStepsGone")}
			</p>
		);
	}

	const seconds = elapsedSeconds(task.startedAt, task.endedAt ?? now);
	const tools = task.steps.filter((step) => step.kind === "tool");
	const errors = tools.filter((step) => step.status === "error").length;
	const lastMessage = [...task.steps].reverse().find((step) => step.kind === "message");
	const result = task.result ?? "";
	const showResult = !running && !!result.trim() &&
		!(lastMessage?.kind === "message" && lastMessage.text.trim() === result.trim());
	const attention = task.status === "failed" || (task.outcome && !["completed"].includes(task.outcome));

	return (
		<div className="relative flex h-full min-h-0 min-w-0 flex-col">
			<div className={cn("relative shrink-0 border-b border-[color:var(--app-surface-divider)] px-4 py-3", running && "tool-scan")}>
				<div className="flex items-start gap-2">
					<BotIcon
						className={cn(
							"mt-0.5 size-4 shrink-0",
							task.status === "failed" ? "text-destructive" : MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					/>
					<span className="min-w-0 flex-1 break-words text-[length:var(--app-font-size-ui,12px)] font-medium leading-relaxed [overflow-wrap:anywhere] line-clamp-2" title={task.description}>{task.description}</span>
					{running && onCancel ? (
						<Button type="button" size="xs" variant="ghost" className="shrink-0" onClick={() => onCancel(task.id)}>
							{t("workflow.cancelTask")}
						</Button>
					) : null}
				</div>
				<div
					className={cn(
						"mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--app-font-size-ui-sm,11px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					<span className={cn("inline-flex items-center gap-1.5", attention && "text-[var(--warning)]", task.status === "failed" && "text-destructive")}>
						{running ? <Spinner className="size-3 shrink-0" /> : attention ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
						{t(task.status === "completed" && task.outcome ? `fusion.outcome.${task.outcome}` : STATUS_KEYS[task.status])}
					</span>
					<span aria-hidden="true">·</span>
					<span>{t(KIND_KEYS[task.kind])}</span>
					<span className="ml-auto tabular-nums">{formatElapsed(seconds)}</span>
					{errors ? <span className="text-destructive">{t("agentMap.errors", { count: errors })}</span> : null}
				</div>
				{task.writablePaths.length ? (
					<details className={cn("mt-2 min-w-0 text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
						<summary className="cursor-pointer rounded-sm hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring">{t("workflow.taskScope")}</summary>
						<div className="mt-1.5 flex flex-col gap-1 border-l border-border/60 pl-3 font-mono [overflow-wrap:anywhere]">
							{task.writablePaths.map((path, index) => <span key={`${path}-${index}`}>{path}</span>)}
						</div>
					</details>
				) : null}
			</div>
			<div
				ref={scrollRef}
				onScroll={() => {
					const el = scrollRef.current;
					if (!el) return;
					const next = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
					if (next !== followRef.current) { followRef.current = next; setFollowing(next); }
				}}
				className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 pb-16"
			>
				{/* Keep the step flow at its natural height. A bounded flex column
				    shrinks overflow-hidden command cards instead of scrolling them. */}
				<div className="flex min-w-0 flex-col gap-4">
				{task.steps.length === 0 ? (
					<p
						className={cn(
							"border-l border-border/60 pl-3 text-[length:var(--app-font-size-chat,12px)]",
							MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						{running ? (
							<span className="shimmer">{t("workflow.taskStarting")}</span>
						) : (
							t(result ? "workflow.taskStepsGone" : "workflow.taskNoSteps")
						)}
					</p>
				) : null}
				{task.steps.map((step) =>
					step.kind === "tool" ? (
						<ToolStep key={step.id} step={step} active={running} />
					) : step.kind === "message" ? (
						<MessageStep key={step.id} step={step} />
					) : (
						<ThinkingBlock
							key={step.id}
							text={step.text}
							active={running && step.endedAt === undefined}
							startedAt={step.startedAt}
							endedAt={step.endedAt ?? (!running ? task.endedAt : undefined)}
						/>
					),
				)}
				{showResult ? (
					<section className="flex min-w-0 flex-col gap-2 border-t border-border/50 pt-4">
						<h3 className={cn("text-[length:var(--app-font-size-ui-sm,11px)] font-medium", MUTED_LABEL_TEXT_CLASS_NAME)}>{t("workflow.taskResult")}</h3>
						<Markdown text={result} />
					</section>
				) : null}
				</div>
			</div>
			{!following ? (
				<Button type="button" size="xs" variant="outline"
					className="absolute bottom-3 right-4 bg-[var(--color-background-elevated-primary-opaque)]"
					onClick={() => {
						followRef.current = true;
						setFollowing(true);
						const el = scrollRef.current;
						if (el) el.scrollTop = el.scrollHeight;
					}}>
					<ArrowDownIcon className="size-3.5" />{t("chat.jumpToLatest")}
				</Button>
			) : null}
		</div>
	);
}
