import { useState } from "react";
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
function renderRunningSummary(task: WorkflowTask, t: (key: TranslationKey) => string) {
	if (task.steps.length === 0) {
		return <span className="shimmer">{t("workflow.taskStarting")}</span>;
	}
	const latest = task.steps[task.steps.length - 1];
	if (latest.kind === "tool") {
		const text = latest.args ? `${latest.toolName} ${latest.args}` : latest.toolName;
		return <span>{text}</span>;
	}
	if (latest.kind === "thinking") {
		const line = lastThinkingLine(latest.text);
		return <span>{line || latest.text || t("workflow.taskStarting")}</span>;
	}
	if (latest.kind === "message") {
		const lines = latest.text.split("\n").map((l) => l.trim()).filter(Boolean);
		const lastLine = lines[lines.length - 1] ?? latest.text;
		return <span>{lastLine || t("workflow.taskStarting")}</span>;
	}
	return null;
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
 * A background worker, wherever it is shown.
 *
 * The same card serves the transcript row that started the worker and the
 * workflow panel that tracks it, because they are the same worker — two
 * different-looking renderings of one delegation would read as two things.
 *
 * Folded by default: watching or opening the detail dock is user-driven.
 */
export function TaskCard({
	task,
	onCancel,
	onOpen,
	defaultOpen = false,
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
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(defaultOpen);
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

	return (
		<div className="@container/task min-w-0 flex flex-col gap-1">
			<div
				className={cn(
					"group/task flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-150 motion-reduce:transition-none",
					"hover:bg-[var(--color-background-elevated-secondary)]",
				)}
			>
				<span
					className={cn(
						"size-1.5 shrink-0 rounded-full",
						getStatusDotClassName(task.status, task.outcome),
					)}
					aria-hidden="true"
				/>
				<button
					type="button"
					title={onOpen ? t("workflow.taskOpenPanel") : undefined}
					onClick={() => {
						if (onOpen) {
							onOpen(task.id);
						} else {
							setOpen((value) => !value);
						}
					}}
					className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					<span className="min-w-0 truncate text-[length:var(--app-font-size-chat,12px)] font-medium text-foreground">
						{task.description}
					</span>
					<span className="hidden shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground @[440px]/task:inline">
						{t(KIND_KEYS[task.kind])}
					</span>
				</button>
				<div className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums">
					<span
						className={cn(
							"min-w-0 break-words text-right",
							task.status === "failed" ? "text-destructive" : "text-muted-foreground",
						)}
					>
						{t(
							task.status === "completed" && task.outcome
								? `fusion.outcome.${task.outcome}`
								: STATUS_KEYS[task.status],
						)}
					</span>
					<span className="shrink-0 text-muted-foreground/40">·</span>
					<span className="shrink-0 text-muted-foreground">{formatElapsed(seconds)}</span>
				</div>
				{running && onCancel ? (
					<Button
						type="button"
						size="xs"
						variant="ghost"
						className="h-6 shrink-0 px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground hover:text-foreground"
						aria-label={t("workflow.cancelTask")}
						onClick={(e) => {
							e.stopPropagation();
							onCancel(task.id);
						}}
					>
						{t("workflow.cancelTask")}
					</Button>
				) : null}
				<button
					type="button"
					aria-expanded={open}
					aria-label={t(open ? "workflow.taskCollapse" : "workflow.taskExpand")}
					onClick={(e) => {
						e.stopPropagation();
						setOpen((value) => !value);
					}}
					className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					<ChevronRightIcon className="workflow-chevron size-3.5" data-open={open} />
				</button>
			</div>
			{running && !open ? (
				<div className="ml-4 min-w-0 truncate px-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{renderRunningSummary(task, t)}
				</div>
			) : null}
			<DisclosureRegion open={open}>
				<div className="mt-1 ml-4 min-w-0 flex flex-col gap-2 rounded-md border border-border/40 bg-foreground/2 px-2.5 py-2">
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
