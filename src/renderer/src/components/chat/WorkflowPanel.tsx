import { useState } from "react";
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

function QuestionCard({ request }: { request: WorkflowRequest }) {
	const { t } = useTranslation();
	const [answers, setAnswers] = useState<WorkflowAnswer["answers"]>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const complete = request.questions.every(
		(q) => answers[q.id]?.optionId || answers[q.id]?.text?.trim(),
	);
	const send = async (cancelled = false) => {
		setBusy(true);
		setError("");
		try {
			await api.agentAnswerWorkflow({ requestId: request.id, answers, cancelled });
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			aria-label={request.title}
			className="rounded-lg border border-border bg-muted/30 p-3"
			onSubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<h3 className="mb-2 font-medium">{request.title}</h3>
			{request.questions.map((question) => (
				<fieldset key={question.id} disabled={busy} className="mb-3 min-w-0 space-y-2">
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
			))}
			{error ? (
				<p role="alert" className="mb-2 text-destructive">
					{error}
				</p>
			) : null}
			<div className="flex justify-end gap-2">
				<Button
					type="button"
					size="xs"
					variant="outline"
					disabled={busy}
					onClick={() => void send(true)}
				>
					{t("common.cancel")}
				</Button>
				<Button type="submit" size="xs" variant="prominent" disabled={busy || !complete}>
					{t("workflow.submit")}
				</Button>
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
}: {
	workflow: WorkflowSnapshot;
	onOpenTask?: (taskId: string) => void;
}) {
	const [error, setError] = useState("");
	if (!workflow.request && !workflow.todos.length && !workflow.tasks.length) return null;
	return (
		<div className={cn("shrink-0 pb-1", CHAT_COLUMN_GUTTER_CLASS_NAME)}>
			<div
				className={cn(
					CHAT_COLUMN_FRAME_CLASS_NAME,
					"max-h-[40vh] space-y-2 overflow-y-auto text-[length:var(--app-font-size-ui,12px)]",
				)}
			>
				{workflow.request ? (
					<QuestionCard key={workflow.request.id} request={workflow.request} />
				) : null}
				{workflow.todos.length || workflow.tasks.length ? (
					<ProgressSection
						workflow={workflow}
						onOpenTask={onOpenTask}
						onCancel={(id) => {
							void api.agentCancelTask(id).catch((cause) => setError(errorMessage(cause)));
						}}
					/>
				) : null}
				{error ? (
					<p role="alert" className="text-destructive">
						{error}
					</p>
				) : null}
			</div>
		</div>
	);
}
