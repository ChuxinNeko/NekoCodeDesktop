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
	XIcon,
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

/** Keep result previews plain and short; the full Markdown belongs in the detail view. */
function resultSummary(result?: string): string {
	const lines = (result ?? "").split("\n").map(line => line.trim()).filter(Boolean);
	return (lines.find(line => !/^#{1,6}\s/.test(line)) ?? lines[0] ?? "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^[\s>#*-]+/, "").replace(/[*`]/g, "").slice(0, 500);
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
	const summary = running ? runningSummary(task, t) : variant === "transcript" ? resultSummary(task.result) : "";
	const attention = task.outcome && ["blocked", "needs_decision", "needs_escalation"].includes(task.outcome);

	return (
		<div data-task-summary={variant} data-task-id={task.id} className="@container/task group/task min-w-0">
			<div className="flex min-w-0 items-start gap-2 rounded-md px-2 py-2 transition-colors hover:bg-muted/35 motion-reduce:transition-none">
				<span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
					<span className={cn("size-1.5 rounded-full", getStatusDotClassName(task.status, task.outcome))} />
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2">
						<button type="button"
							title={[t(KIND_KEYS[task.kind]), task.description, t(onOpen ? "workflow.taskOpenPanel" : expanded ? "workflow.taskCollapse" : "workflow.taskExpand")].join(" · ")}
							aria-expanded={inlineDetails ? expanded : undefined} aria-controls={inlineDetails ? detailId : undefined}
							onClick={() => onOpen ? onOpen(task.id) : setOpen(value => !value)}
							className="flex min-w-0 flex-1 items-center gap-1 rounded text-left text-[length:var(--app-font-size-ui,12px)] font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring">
							<span className="truncate">{task.description}</span>
							<ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground/60", inlineDetails && "workflow-chevron")} data-open={expanded} />
						</button>
						<span className={cn("max-w-[45%] shrink-0 truncate text-[length:var(--app-font-size-ui-xs,10px)]", task.status === "failed" ? "text-destructive" : attention ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
							{t(task.status === "completed" && task.outcome ? `fusion.outcome.${task.outcome}` : STATUS_KEYS[task.status])}
						</span>
						<span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground/70">{formatElapsed(seconds)}</span>
						{running && onCancel ? <Button type="button" size="icon-chip" variant="ghost" className="size-5 text-muted-foreground hover:text-destructive"
							aria-label={t("workflow.cancelTask")} title={t("workflow.cancelTask")} onClick={() => onCancel(task.id)}><XIcon className="size-3" /></Button> : null}
					</div>
					{summary && !expanded ? <p className={cn("mt-0.5 truncate text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground", running && !task.steps.length && "shimmer")} title={summary}>{summary}</p> : null}
				</div>
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
