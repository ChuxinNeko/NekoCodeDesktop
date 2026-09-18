import { useState } from "react";
import {
	MAX_WORKERS,
	type TaskStep,
	type WorkflowTask,
} from "../../../../shared/workflow";
import { useTranslation, type TranslationKey } from "../../i18n";
import { elapsedSeconds, formatElapsed, useNow } from "../../lib/elapsed";
import {
	BotIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	HammerIcon,
	TriangleAlertIcon,
} from "../../lib/icons";
import { cn } from "../../lib/utils";
import { lastThinkingLine } from "./Thinking";
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
 * Open while it runs: a worker is the one part of a turn the user cannot see
 * from the transcript, so watching it is the default and folding it away is
 * the choice.
 */
export function TaskCard({
	task,
	onCancel,
	onOpen,
}: {
	task: WorkflowTask;
	/** Omitted where cancelling does not belong, e.g. the transcript. */
	onCancel?: (id: string) => void;
	/**
	 * Show this worker's full run in the dock. Omitted inside the dock itself,
	 * where the header goes back to being a plain disclosure.
	 */
	onOpen?: (id: string) => void;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(task.status === "running");
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
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5">
				{/* The chevron owns folding; the label opens the worker's own panel,
				    because the card is a summary and the run is the thing. */}
				<button
					type="button"
					aria-expanded={open}
					aria-label={t(open ? "workflow.taskCollapse" : "workflow.taskExpand")}
					onClick={() => setOpen((value) => !value)}
					className="shrink-0"
				>
					{open ? (
						<ChevronDownIcon className={cn("size-3.5", MUTED_LABEL_TEXT_CLASS_NAME)} />
					) : (
						<ChevronRightIcon className={cn("size-3.5", MUTED_LABEL_TEXT_CLASS_NAME)} />
					)}
				</button>
				<button
					type="button"
					title={onOpen ? t("workflow.taskOpenPanel") : undefined}
					onClick={() => (onOpen ? onOpen(task.id) : setOpen((value) => !value))}
					className={cn(
						"flex min-w-0 flex-1 items-center gap-1.5 rounded text-left",
						onOpen && "hover:bg-[var(--color-background-elevated-secondary)]",
					)}
				>
					<BotIcon
						className={cn(
							"size-3.5 shrink-0",
							task.status === "failed" ? "text-destructive" : MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					/>
					<span className="min-w-0 truncate text-[length:var(--app-font-size-chat,12px)] font-medium">
						{task.description}
					</span>
					<span
						className={cn(
							"shrink-0 rounded-full border border-border/60 px-1.5",
							"text-[length:var(--app-font-size-ui-sm,11px)]",
							MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						{t(KIND_KEYS[task.kind])}
					</span>
					<span className="flex-1" />
					{running ? <Spinner className="size-3 shrink-0 text-muted-foreground" /> : null}
					<span
						className={cn(
							"shrink-0 text-[length:var(--app-font-size-ui-sm,11px)]",
							task.status === "failed" ? "text-destructive" : MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						{t(STATUS_KEYS[task.status])} · {formatElapsed(seconds)}
					</span>
				</button>
				{running && onCancel ? (
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="shrink-0"
						onClick={() => onCancel(task.id)}
					>
						{t("workflow.cancelTask")}
					</Button>
				) : null}
			</div>
			{open ? (
				<div className="flex flex-col gap-1.5 border-l border-border/60 pl-3">
					{task.writablePaths.length ? (
						<p
							className={cn(
								"break-all text-[length:var(--app-font-size-ui-sm,11px)]",
								MUTED_LABEL_TEXT_CLASS_NAME,
							)}
						>
							{t("workflow.taskScope")}: {task.writablePaths.join(", ")}
						</p>
					) : null}
					{tools.map((step) => (
						<StepRow key={step.id} step={step} />
					))}
					{/* The card stays a summary: reasoning is a line of it here, and the
					    whole stream is a click away in the dock. */}
					{running && reasoning ? (
						<div className="truncate border-l border-border/60 pl-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
							{lastThinkingLine(reasoning.text)}
						</div>
					) : null}
					{running && task.steps.length === 0 ? (
						<p
							className={cn(
								"text-[length:var(--app-font-size-ui-sm,11px)]",
								MUTED_LABEL_TEXT_CLASS_NAME,
							)}
						>
							<span className="shimmer">{t("workflow.taskStarting")}</span>
						</p>
					) : null}
					{/* Steps are live-only, so a reopened session has a result and no
					    trace of how it got there. Say so rather than look empty. */}
					{!running && task.steps.length === 0 && task.result ? (
						<p
							className={cn(
								"text-[length:var(--app-font-size-ui-sm,11px)]",
								MUTED_LABEL_TEXT_CLASS_NAME,
							)}
						>
							{t("workflow.taskStepsGone")}
						</p>
					) : null}
					{task.result ? (
						<pre
							className={cn(
								"max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg",
								"border border-border/60 bg-[var(--color-token-text-code-block-background)] p-2.5",
								"font-mono text-[length:var(--app-font-size-chat-code,11px)]",
							)}
						>
							{task.result}
						</pre>
					) : null}
				</div>
			) : null}
		</div>
	);
}
