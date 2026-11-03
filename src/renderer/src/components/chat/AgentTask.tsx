import { useId, useState } from "react";
import {
	MAX_WORKERS,
	type TaskStep,
	type WorkflowTask,
} from "../../../../shared/workflow";
import { useTranslation, type TranslationKey } from "../../i18n";
import { elapsedSeconds, formatElapsed, useNow } from "../../lib/elapsed";
import {
	ChevronRightIcon,
	HammerIcon,
	TriangleAlertIcon,
	CircleCheckIcon,
	CircleAlertIcon,
	CircleXIcon,
} from "../../lib/icons";
import { cn } from "../../lib/utils";
import { lastThinkingLine } from "./Thinking";
import { Markdown } from "./Markdown";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { DisclosureRegion } from "../ui/disclosure-region";
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

/**
 * Determine the status dot color for a task row.
 * Completed runs with abnormal outcomes (blocked/needs_decision/needs_escalation)
 * are styled amber rather than green success.
 */
export function getStatusDotClassName(
	status: WorkflowTask["status"],
	outcome?: WorkflowTask["outcome"],
): string {
	if (status === "running") {
		return "bg-sky-500";
	}
	if (status === "failed") {
		return "bg-destructive";
	}
	if (status === "cancelled") {
		return "bg-amber-500";
	}
	// status === "completed"
	if (outcome === "blocked" || outcome === "needs_decision" || outcome === "needs_escalation") {
		return "bg-amber-500";
	}
	return "bg-emerald-500";
}

/**
 * Extract a single line summarizing the latest activity of a running worker.
 */
function runningSummary(task: WorkflowTask, t: (key: TranslationKey) => string): string {
	if (task.steps.length === 0) {
		return t("workflow.taskStarting");
	}
	const latest = task.steps[task.steps.length - 1];
	if (latest.kind === "tool") {
		const text = latest.args ? `${latest.toolName} ${latest.args}` : latest.toolName;
		return text;
	}
	if (latest.kind === "thinking") {
		const line = lastThinkingLine(latest.text);
		return line || latest.text || t("workflow.taskStarting");
	}
	if (latest.kind === "message") {
		const lines = latest.text.split("\n").map((l) => l.trim()).filter(Boolean);
		const lastLine = lines[lines.length - 1] ?? latest.text;
		return lastLine || t("workflow.taskStarting");
	}
	return "";
}

/**
 * How much of the worker pool is in use, as the pool itself.
 *
 * Four slots are drawn whether or not they are taken, because the ceiling is
 * the part worth knowing: "two running" says nothing about whether a third
 * would start. A count alone would leave the user to remember the limit.
 */
export function WorkerSlots({ running, max = MAX_WORKERS }: { running: number; max?: number }) {
	return (
		<span className="inline-flex items-center gap-0.5 align-middle" aria-hidden="true">
			{Array.from({ length: max }, (_, slot) => (
				<span
					key={slot}
					// Filled, not coloured: a busy slot is a fact about capacity, and
					// an alert tone would read as something having gone wrong.
					className={cn(
						"size-1.5 rounded-full",
						slot < running ? "bg-foreground/70" : "bg-foreground/15",
					)}
				/>
			))}
		</span>
	);
}

/** One tool call the worker made, in the transcript's own idiom. */
export function StepRow({ step }: { step: Extract<TaskStep, { kind: "tool" }> }) {
	const now = useNow(step.status === "running");
	const seconds = elapsedSeconds(step.startedAt, step.endedAt ?? now);
	return (
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
			<span
				className={cn(
					"min-w-0 flex-1 truncate font-mono text-[length:var(--app-font-size-ui-sm,11px)]",
					MUTED_LABEL_TEXT_CLASS_NAME,
				)}
			>
				{step.args}
			</span>
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
	);
}

/** Same compact status marks as baocode; abnormal completion remains visible. */
export function TaskStatusIcon({ task }: { task: Pick<WorkflowTask, "status" | "outcome"> }) {
	if (task.status === "running") return <span aria-hidden="true" className="task-pixel-loader grid size-3.5 shrink-0 grid-cols-[repeat(3,3px)] grid-rows-[repeat(3,3px)] gap-0.5 text-muted-foreground">
		{Array.from({ length: 9 }, (_, index) => <span key={index} className="bg-current" style={{ animationDelay: `${index * 0.1}s` }} />)}
	</span>;
	const attention = task.outcome && ["blocked", "needs_decision", "needs_escalation"].includes(task.outcome);
	const Icon = task.status === "failed" || attention ? CircleAlertIcon : task.status === "cancelled" ? CircleXIcon : CircleCheckIcon;
	return <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", task.status === "failed" ? "text-destructive" : attention || task.status === "cancelled" ? "text-amber-500" : "text-emerald-500")} />;
}

/**
 * A shared task row: live activity in the workflow, brief results in the transcript.
 * Inline details are a fallback for surfaces without a right-side detail dock.
 */
export function TaskCard({
	task,
	onCancel,
	onOpen,
	defaultOpen = false,
	variant = "transcript",
}: {
	task: WorkflowTask;
	/** Omitted where cancelling does not belong, e.g. the transcript. */
	onCancel?: (id: string) => void;
	/**
	 * Show this worker's full run in the dock. Omitted inside the dock itself,
	 * where the header goes back to being a plain disclosure.
	 */
	onOpen?: (id: string) => void;
	/** For testing or forced disclosure. Defaults to false. */
	defaultOpen?: boolean;
	variant?: "workflow" | "transcript";
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(defaultOpen);
	const detailId = useId();
	const inlineDetails = !onOpen;
	const expanded = inlineDetails && open;
	const running = task.status === "running";
	const now = useNow(running);
	const seconds = elapsedSeconds(task.startedAt, task.endedAt ?? now);
	const tools = task.steps.filter(
		(step): step is Extract<TaskStep, { kind: "tool" }> => step.kind === "tool",
	);
	// Only the newest, and only while it is open: older reasoning is history the
	// detail panel keeps, not something a summary row should carry.
	const newest = task.steps[task.steps.length - 1];
	const reasoning =
		newest?.kind === "thinking" && newest.endedAt === undefined ? newest : undefined;
	const summary = running ? runningSummary(task, t).replace(/\s+/g, " ") : [
		t(KIND_KEYS[task.kind]), formatElapsed(seconds),
		...(tools.length ? [t(tools.length === 1 ? "workFlow.toolCall" : "workFlow.toolCalls", { count: tools.length })] : []),
	].join(" · ");
	const attention = task.outcome && ["blocked", "needs_decision", "needs_escalation"].includes(task.outcome);

	return (
		<div data-task-summary={variant} data-task-id={task.id} className="@container/task group/task min-w-0">
			<div className={cn("relative flex min-w-0 items-center transition-colors duration-120 motion-reduce:transition-none", variant === "workflow" ? "rounded-md hover:bg-muted/40" : "my-0.5 mb-1.5 rounded-lg border border-border bg-muted/20 hover:border-muted-foreground/40 hover:bg-muted/40 focus-within:border-ring")}>
				<button type="button"
					title={[task.description, summary, t(onOpen ? "workflow.taskOpenPanel" : expanded ? "workflow.taskCollapse" : "workflow.taskExpand")].join(" · ")}
					aria-label={`${task.description} · ${t(task.status === "completed" && task.outcome ? `fusion.outcome.${task.outcome}` : STATUS_KEYS[task.status])} · ${t(onOpen ? "workflow.taskOpenPanel" : expanded ? "workflow.taskCollapse" : "workflow.taskExpand")}`}
					aria-expanded={inlineDetails ? expanded : undefined} aria-controls={inlineDetails ? detailId : undefined}
					onClick={() => onOpen ? onOpen(task.id) : setOpen(value => !value)}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-[9px] pl-3 pr-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring">
					<TaskStatusIcon task={task} />
					<span className="flex min-w-0 flex-1 items-center leading-[1.4]">
						<span className={cn("min-w-0 truncate", variant === "workflow" ? "text-[11.5px]" : "text-[13px] font-medium", running && "shimmer")}>{task.description}</span>
						<span className="ml-1.5 max-w-[50%] shrink truncate text-[12px] text-muted-foreground/75">
							<span key={summary} className="task-activity-flip inline-block max-w-full truncate align-middle">· {summary}</span>
						</span>
					</span>
					{variant === "workflow" ? <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">{formatElapsed(seconds)}</span> : null}
					{attention ? <span className="max-w-[25%] truncate text-[12px] text-amber-700 dark:text-amber-400">{t(`fusion.outcome.${task.outcome!}`)}</span> : null}
					<ChevronRightIcon aria-hidden="true" className={cn("size-[18px] shrink-0 text-muted-foreground", inlineDetails && "workflow-chevron")} data-open={expanded} />
				</button>
				{running && onCancel ? <Button type="button" size="icon-chip" variant="ghost" className="mr-2 size-6 shrink-0 text-muted-foreground hover:text-destructive"
					aria-label={t("workflow.cancelTask")} title={t("workflow.cancelTask")} onClick={() => onCancel(task.id)}><span aria-hidden="true" className="size-2.5 rounded-[1px] bg-current" /></Button> : null}
			</div>
			<DisclosureRegion id={detailId} open={expanded}>
				<div className="mb-2 ml-[1.375rem] min-w-0 flex flex-col gap-2 border-l border-border/50 px-3 py-1">
					{task.writablePaths.length ? (
						<p className="break-all text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							{t("workflow.taskScope")}: {task.writablePaths.join(", ")}
						</p>
					) : null}
					{tools.length > 0 ? (
						<div className="flex max-h-56 flex-col gap-2 overflow-y-auto overscroll-contain">
							{tools.map((step) => (
								<StepRow key={step.id} step={step} />
							))}
						</div>
					) : null}
					{running && reasoning ? (
						<div className="truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							{lastThinkingLine(reasoning.text)}
						</div>
					) : null}
					{running && task.steps.length === 0 ? (
						<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							<span className="shimmer">{t("workflow.taskStarting")}</span>
						</p>
					) : null}
					{!running && task.steps.length === 0 && task.result ? (
						<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							{t("workflow.taskStepsGone")}
						</p>
					) : null}
					{task.result ? (
						<div className="max-h-64 min-w-0 overflow-y-auto break-words text-[length:var(--app-font-size-chat,12px)]">
							<Markdown text={task.result} />
						</div>
					) : null}
				</div>
			</DisclosureRegion>
		</div>
	);
}
