import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	MAX_WORKERS,
	type WorkflowAnswer,
	type WorkflowRequest,
	type WorkflowSnapshot,
} from "../../../../shared/workflow";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import { ChevronDownIcon, ChevronRightIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import { TaskCard, WorkerSlots } from "./AgentTask";
import {
	CHAT_COLUMN_FRAME_CLASS_NAME,
	CHAT_COLUMN_GUTTER_CLASS_NAME,
} from "./composerPickerStyles";
import { cn } from "../../lib/utils";

/**
 * Has this question been answered — by picking an option, or by typing instead?
 *
 * The free-text field is a real answer, not a footnote to one: a user who finds
 * none of the options right says so there, and the card must not hold them back
 * for refusing to pick.
 */
export function isAnswered(answers: WorkflowAnswer["answers"], id: string): boolean {
	return Boolean(answers[id]?.optionId || answers[id]?.text?.trim());
}

function QuestionCard({ request, onAnswer }: { request: WorkflowRequest; onAnswer?: (answer: WorkflowAnswer) => Promise<unknown> }) {
	const { t } = useTranslation();
	const [answers, setAnswers] = useState<WorkflowAnswer["answers"]>({});
	const [page, setPage] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const options = useRef<HTMLDivElement | null>(null);

	const total = request.questions.length;
	// One question per page, but only once there is more than one: a "1/1" and a
	// Next button on a single question is chrome that says nothing.
	const paged = total > 1;
	const index = Math.min(page, total - 1);
	const question = request.questions[index];
	const last = index >= total - 1;
	const complete = request.questions.every((entry) => isAnswered(answers, entry.id));

	// A new page starts at its own top; inheriting the previous page's scroll
	// would open question two halfway down its options.
	useEffect(() => {
		options.current?.scrollTo({ top: 0 });
	}, [index]);

	const send = async (cancelled = false) => {
		setBusy(true);
		setError("");
		try {
			await (onAnswer ?? api.agentAnswerWorkflow)({ requestId: request.id, answers, cancelled });
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	return (
		// Three bands: what is being asked, the choices, and the reply. Only the
		// middle one scrolls — with a dozen options the question being answered and
		// the button that answers it are exactly what must not scroll away, and a
		// card that moves as one block loses both at once.
		<form
			aria-label={request.title}
			className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-muted/30"
			onSubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<div
				data-slot="question-header"
				className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/40 px-3 py-2"
			>
				<h3 className="min-w-0 flex-1 truncate font-medium">{request.title}</h3>
				{paged ? (
					<span
						data-slot="question-pager"
						aria-label={t("workflow.stepOf", { current: index + 1, total })}
						className="shrink-0 tabular-nums text-muted-foreground"
					>
						{index + 1}/{total}
					</span>
				) : null}
			</div>

			{/* `min-h-0` is what lets this shrink below its content so the bands
			    above and below it stay put; without it a flex child refuses to go
			    under its intrinsic height and the whole card grows instead. */}
			<div
				ref={options}
				data-slot="question-options"
				className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2.5"
			>
				{/* One question at a time. Answers live outside this render, keyed by
				    question id, so paging back and forth never loses a pick. */}
				<fieldset key={question.id} disabled={busy} className="min-w-0 space-y-2">
					<legend className="sr-only">{question.question}</legend>
					<div className="chat-markdown">
						<ReactMarkdown remarkPlugins={[remarkGfm]}>{question.question}</ReactMarkdown>
					</div>
					{question.options.map((option) => (
						<label
							key={option.id}
							className="flex cursor-pointer items-start gap-2 rounded border border-border/60 p-2 hover:bg-muted/60"
						>
							<input
								className="mt-0.5"
								type="radio"
								name={request.id + question.id}
								checked={answers[question.id]?.optionId === option.id}
								onChange={() =>
									setAnswers((value) => ({
										...value,
										[question.id]: { ...value[question.id], optionId: option.id },
									}))
								}
							/>
							<span>
								<span className="font-medium">{option.label}</span>
								{option.description ? (
									<span className="block text-muted-foreground">{option.description}</span>
								) : null}
							</span>
						</label>
					))}
					{request.kind === "question" ? (
						<textarea
							aria-label={t("workflow.otherAnswer")}
							placeholder={t("workflow.otherAnswer")}
							rows={2}
							maxLength={6000}
							value={answers[question.id]?.text ?? ""}
							onChange={(event) =>
								setAnswers((value) => ({
									...value,
									[question.id]: { ...value[question.id], text: event.target.value },
								}))
							}
							className="w-full resize-y rounded border border-border bg-background p-2 outline-none focus:ring-1 focus:ring-ring"
						/>
					) : null}
				</fieldset>
			</div>

			<div
				data-slot="question-actions"
				className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-muted/40 px-3 py-2"
			>
				{error ? (
					// Beside the buttons rather than above them: it is the reason the
					// reply did not go through, and this row is where the eye already is.
					<p role="alert" className="mr-auto min-w-0 truncate text-destructive">
						{error}
					</p>
				) : null}
				<Button
					type="button"
					size="xs"
					variant="outline"
					disabled={busy}
					onClick={() => void send(true)}
				>
					{t("common.cancel")}
				</Button>
				{paged && index > 0 ? (
					<Button
						type="button"
						size="xs"
						variant="outline"
						disabled={busy}
						onClick={() => setPage(index - 1)}
					>
						{t("workflow.previous")}
					</Button>
				) : null}
				{last ? (
					<Button type="submit" size="xs" variant="prominent" disabled={busy || !complete}>
						{t("workflow.submit")}
					</Button>
				) : (
					// Gated on this page's answer, not on the whole card: the next
					// question may depend on this one, and letting someone skip ahead
					// would land them on the last page with a dead submit button.
					<Button
						type="button"
						size="xs"
						variant="prominent"
						disabled={busy || !isAnswered(answers, question.id)}
						onClick={() => setPage(index + 1)}
					>
						{t("workflow.next")}
					</Button>
				)}
			</div>
		</form>
	);
}
const TODO_STATUS_KEYS: Record<string, TranslationKey> = {
	pending: "workflow.pending",
	in_progress: "workflow.running",
	running: "workflow.running",
	completed: "workflow.completed",
	failed: "workflow.failed",
	cancelled: "workflow.cancelled",
};

/**
 * The todo list and the worker pool, above the composer.
 *
 * The header carries the pool even when the body is folded away: how many
 * workers are running is the one thing worth knowing at a glance, and a user
 * who collapsed the panel to read the transcript should not lose it.
 */
function ProgressSection({
	workflow,
	onCancel,
	onOpenTask,
}: {
	workflow: WorkflowSnapshot;
	onCancel: (id: string) => void;
	onOpenTask?: (taskId: string) => void;
}) {
	const { t } = useTranslation();
	const running = workflow.tasks.filter((task) => task.status === "running").length;
	// Opens itself when there is work to watch; the user's toggle wins after that.
	const [open, setOpen] = useState(() => workflow.tasks.length > 0);

	return (
		<div className="rounded-lg border border-border px-3 py-2">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center gap-1.5 text-left"
			>
				{open ? (
					<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
				)}
				<span className="min-w-0 flex-1 truncate text-muted-foreground">
					{t("workflow.progress", { todos: workflow.todos.length, running })}
				</span>
				{workflow.tasks.length ? (
					<span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
						<WorkerSlots running={running} max={workflow.maxWorkers} />
						{t("workflow.workers", { running, max: workflow.maxWorkers ?? MAX_WORKERS })}
					</span>
				) : null}
			</button>
			{open ? (
				<div className="mt-2 space-y-2">
					{workflow.todos.length ? (
						<ul className="space-y-1">
							{workflow.todos.map((todo) => (
								<li key={todo.id} className="flex gap-2">
									<span className="shrink-0 text-muted-foreground">
										{t(TODO_STATUS_KEYS[todo.status])}
									</span>
									<span className={todo.status === "completed" ? "line-through opacity-60" : ""}>
										{todo.text}
									</span>
								</li>
							))}
						</ul>
					) : null}
					{workflow.tasks.length ? (
						<div className="space-y-2 border-t border-border pt-2">
							{workflow.tasks.map((task) => (
								<TaskCard
									key={task.id}
									task={task}
									onCancel={onCancel}
									onOpen={onOpenTask}
								/>
							))}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function WorkflowPanel({
	workflow,
	onOpenTask,
	onAnswer,
	onCancelWorker,
}: {
	workflow: WorkflowSnapshot;
	onOpenTask?: (taskId: string) => void;
	onAnswer?: (answer: WorkflowAnswer) => Promise<unknown>;
	onCancelWorker?: (id: string) => Promise<unknown>;
}) {
	const [error, setError] = useState("");
	if (!workflow.request && !workflow.todos.length && !workflow.tasks.length) return null;
	return (
		<div className={cn("shrink-0 pb-1", CHAT_COLUMN_GUTTER_CLASS_NAME)}>
			{/* A column rather than one scrolling box: each section below owns its
			    own overflow, which is what keeps the question card's header and
			    buttons pinned instead of scrolling out with everything else. */}
			<div
				className={cn(
					CHAT_COLUMN_FRAME_CLASS_NAME,
					"flex max-h-[40vh] flex-col gap-2 text-[length:var(--app-font-size-ui,12px)]",
				)}
			>
				{workflow.request ? (
					<QuestionCard key={workflow.request.id} request={workflow.request} onAnswer={onAnswer} />
				) : null}
				{workflow.todos.length || workflow.tasks.length ? (
					// Progress steps back while a question is waiting: the answer is
					// what unblocks the run, so it gets the height and this gets a
					// fixed sliver it can scroll inside.
					<div
						className={cn(
							"min-h-0 overflow-y-auto",
							workflow.request ? "max-h-24 shrink-0" : "flex-1",
						)}
					>
						<ProgressSection
							workflow={workflow}
							onOpenTask={onOpenTask}
							onCancel={(id) => {
								void (onCancelWorker ?? api.agentCancelTask)(id).catch((cause) => setError(errorMessage(cause)));
							}}
						/>
					</div>
				) : null}
				{error ? (
					<p role="alert" className="shrink-0 text-destructive">
						{error}
					</p>
				) : null}
			</div>
		</div>
	);
}
