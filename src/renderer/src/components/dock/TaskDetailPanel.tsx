import { useLayoutEffect, useRef } from "react";
import type { TaskStep, WorkflowTask } from "../../../../shared/workflow";
import { useTranslation, type TranslationKey } from "../../i18n";
import { elapsedSeconds, formatElapsed, useNow } from "../../lib/elapsed";
import { BotIcon, HammerIcon, TriangleAlertIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { ThinkingBlock } from "../chat/Thinking";
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

const BLOCK_CLASS_NAME = cn(
	"max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg",
	"border border-border/60 bg-[var(--color-token-text-code-block-background)] p-2.5",
	"font-mono text-[length:var(--app-font-size-chat-code,11px)]",
);

/** A tool call with everything it returned — the transcript row, unfolded. */
function ToolStep({ step }: { step: Extract<TaskStep, { kind: "tool" }> }) {
	const { t } = useTranslation();
	const now = useNow(step.status === "running");
	const seconds = elapsedSeconds(step.startedAt, step.endedAt ?? now);
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-1.5">
				{step.status === "running" ? (
					<Spinner className="size-3.5 shrink-0 text-muted-foreground" />
				) : step.status === "error" ? (
					<TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />
				) : (
					<HammerIcon className={cn("size-3.5 shrink-0", MUTED_LABEL_TEXT_CLASS_NAME)} />
				)}
				<span className="shrink-0 text-[length:var(--app-font-size-chat,12px)] font-medium">
					{step.toolName}
				</span>
				<span className="flex-1" />
				{seconds > 0 ? (
					<span
						className={cn(
							"shrink-0 tabular-nums text-[length:var(--app-font-size-ui-sm,11px)]",
							MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						{formatElapsed(seconds)}
					</span>
				) : null}
			</div>
			{step.args ? (
				<pre className={cn(BLOCK_CLASS_NAME, "max-h-24")}>{step.args}</pre>
			) : null}
			{step.output ? (
				<>
					<span
						className={cn(
							"text-[length:var(--app-font-size-ui-sm,11px)]",
							MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						{t("workflow.taskOutput")}
					</span>
					<pre className={BLOCK_CLASS_NAME}>{step.output}</pre>
				</>
			) : null}
		</div>
	);
}

/** What the worker said between calls, which is what ties them together. */
function MessageStep({ step }: { step: Extract<TaskStep, { kind: "message" }> }) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col gap-1 border-l-2 border-border pl-2">
			<span
				className={cn(
					"text-[length:var(--app-font-size-ui-sm,11px)]",
					MUTED_LABEL_TEXT_CLASS_NAME,
				)}
			>
				{t("workflow.taskSaid")}
			</span>
			<p className="whitespace-pre-wrap break-words text-[length:var(--app-font-size-chat,12px)]">
				{step.text}
			</p>
		</div>
	);
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
	const running = task?.status === "running";
	const now = useNow(running);
	const stepCount = task?.steps.length ?? 0;
	// Reasoning grows in place without adding a step, so the count alone would
	// stop following the tail exactly while there is most to follow.
	const tail = task?.steps[stepCount - 1];
	const tailSize = tail ? (tail.kind === "tool" ? (tail.output?.length ?? 0) : tail.text.length) : 0;

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el || !followRef.current) return;
		el.scrollTop = el.scrollHeight;
	}, [stepCount, tailSize, task?.status]);

	if (!task) {
		return (
			<p className={cn("p-3 text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
				{t("workflow.taskStepsGone")}
			</p>
		);
	}

	const seconds = elapsedSeconds(task.startedAt, task.endedAt ?? now);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="shrink-0 border-b border-[color:var(--app-surface-divider)] p-3">
				<div className="flex items-center gap-1.5">
					<BotIcon
						className={cn(
							"size-4 shrink-0",
							task.status === "failed" ? "text-destructive" : MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					/>
					<span className="min-w-0 flex-1 truncate font-medium">{task.description}</span>
					{running ? <Spinner className="size-3.5 shrink-0 text-muted-foreground" /> : null}
				</div>
				<div
					className={cn(
						"mt-1 flex flex-wrap items-center gap-x-2 text-[length:var(--app-font-size-ui-sm,11px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					<span>{t(KIND_KEYS[task.kind])}</span>
					<span>·</span>
					<span className={task.status === "failed" ? "text-destructive" : undefined}>
						{t(STATUS_KEYS[task.status])}
					</span>
					<span>·</span>
					<span className="tabular-nums">{formatElapsed(seconds)}</span>
				</div>
				{task.writablePaths.length ? (
					<p
						className={cn(
							"mt-1 break-all text-[length:var(--app-font-size-ui-sm,11px)]",
							MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						{t("workflow.taskScope")}: {task.writablePaths.join(", ")}
					</p>
				) : null}
				{running && onCancel ? (
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="mt-2"
						onClick={() => onCancel(task.id)}
					>
						{t("workflow.cancelTask")}
					</Button>
				) : null}
			</div>
			<div
				ref={scrollRef}
				onScroll={() => {
					const el = scrollRef.current;
					if (!el) return;
					followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
				}}
				className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
			>
				{task.steps.length === 0 ? (
					<p
						className={cn(
							"text-[length:var(--app-font-size-ui-sm,11px)]",
							MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						{running ? (
							<span className="shimmer">{t("workflow.taskStarting")}</span>
						) : (
							t("workflow.taskNoSteps")
						)}
					</p>
				) : null}
				{task.steps.map((step) =>
					step.kind === "tool" ? (
						<ToolStep key={step.id} step={step} />
					) : step.kind === "message" ? (
						<MessageStep key={step.id} step={step} />
					) : (
						<ThinkingBlock
							key={step.id}
							text={step.text}
							active={step.endedAt === undefined}
							startedAt={step.startedAt}
							endedAt={step.endedAt}
						/>
					),
				)}
			</div>
		</div>
	);
}
