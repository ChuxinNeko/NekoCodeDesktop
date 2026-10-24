import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { markdownRemarkPlugins, markdownRehypePlugins } from "../../lib/markdownPlugins";
import {
	MAX_WORKERS,
	type WorkflowAnswer,
	type WorkflowRequest,
	type WorkflowSnapshot,
	type WorkflowTodo,
} from "../../../../shared/workflow";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	CircleCheckIcon,
	CircleDotIcon,
	CircleIcon,
	CircleXIcon,
} from "../../lib/icons";
import { Button } from "../ui/button";
import { TaskCard, WorkerSlots } from "./AgentTask";
import { FusionEngineInspector } from "./FusionEngineInspector";
import { COMPOSER_STACKED_SURFACE_BORDER_CLASS_NAME, COMPOSER_SURFACE_SHADOW_CLASS_NAME } from "./composerPickerStyles";
import { ComposerStackedHeaderFrame } from "./ComposerColumnFrame";
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
						<ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>{question.question}</ReactMarkdown>
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
const TODO_STATUS_KEYS: Record<WorkflowTodo["status"], TranslationKey> = {
	pending: "workflow.pending",
	in_progress: "workflow.running",
	completed: "workflow.completed",
	cancelled: "workflow.cancelled",
};

function TodoStatusIcon({ status }: { status: WorkflowTodo["status"] }) {
	const className = "mt-px size-3.5 shrink-0";
	switch (status) {
		case "completed":
			return <CircleCheckIcon className={cn(className, "text-muted-foreground")} />;
		case "in_progress":
			return <CircleDotIcon className={cn(className, "text-foreground")} />;
		case "cancelled":
			return <CircleXIcon className={cn(className, "text-muted-foreground/70")} />;
		default:
			return <CircleIcon className={cn(className, "text-muted-foreground/70")} />;
	}
}

/**
 * Which step the run is on: the one in progress, or — between steps — how far
 * it has got. Positional rather than a count of finished items, because "3/7"
 * should point at the third row of the list the user is looking at.
 */
export function currentStep(todos: WorkflowTodo[]): { current: number; active?: WorkflowTodo } {
	const index = todos.findIndex((todo) => todo.status === "in_progress");
	if (index >= 0) return { current: index + 1, active: todos[index] };
	return { current: todos.filter((todo) => todo.status === "completed").length };
}

/** Scroll the active step inside the upward-opening panel, without moving the chat. */
function ProgressSection({
	workflow, compact, open, onCancel, onOpenTask,
}: {
	workflow: WorkflowSnapshot;
	compact: boolean;
	open: boolean;
	onCancel: (id: string) => void;
	onOpenTask?: (taskId: string) => void;
}) {
	const { t } = useTranslation();
	const { active } = currentStep(workflow.todos);
	const body = useRef<HTMLOListElement | null>(null);
	const activeRow = useRef<HTMLLIElement | null>(null);
	useEffect(() => {
		const container = body.current, row = activeRow.current;
		if (!open || !container || !row) return;
		const top = row.offsetTop;
		if (top < container.scrollTop || top + row.offsetHeight > container.scrollTop + container.clientHeight) {
			container.scrollTo({ top: Math.max(0, top - container.clientHeight / 3) });
		}
	}, [open, active?.id]);
	return <div className={cn("min-h-0 overflow-y-auto overscroll-contain", compact ? "max-h-32 shrink-0" : "flex-1")} data-slot="workflow-sections">
		{workflow.todos.length ? <section aria-label={t("workflow.stepsSection")}>
			<h3 className="flex items-center justify-between px-2 py-1.5 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground">
				<span>{t("workflow.stepsSection")}</span><span className="tabular-nums text-muted-foreground/70">{workflow.todos.length}</span>
			</h3>
			<ol ref={body} className="relative max-h-40 overflow-y-auto overscroll-contain">
				{workflow.todos.map(todo => <li key={todo.id} ref={todo.id === active?.id ? activeRow : undefined}
					className={cn("flex items-start gap-2 rounded-md px-2 py-1.5", todo.status === "in_progress" && "bg-muted/40")}>
					<TodoStatusIcon status={todo.status} /><span className="sr-only">{t(TODO_STATUS_KEYS[todo.status])}</span>
					<span className={cn("min-w-0 break-words leading-relaxed", todo.status === "in_progress" ? "font-medium text-foreground" :
						todo.status === "completed" || todo.status === "cancelled" ? "text-muted-foreground/65" : "text-foreground/80")}>{todo.text}</span>
				</li>)}
			</ol>
		</section> : null}
		{workflow.tasks.length ? <section aria-label={t("workflow.subagentsSection")} className={cn(workflow.todos.length && "mt-2 border-t border-border/50 pt-2")}>
			<h3 className="flex items-center justify-between px-2 py-1.5 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground">
				<span>{t("workflow.subagentsSection")}</span><span className="tabular-nums text-muted-foreground/70">{workflow.tasks.length}</span>
			</h3>
			<ul className="divide-y divide-border/40">
				{workflow.tasks.map(task => <li key={task.id}><TaskCard task={task} variant="workflow" onCancel={onCancel} onOpen={onOpenTask} /></li>)}
			</ul>
		</section> : null}
	</div>;
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
	const { t } = useTranslation();
	const [error, setError] = useState("");
	const [open, setOpen] = useState(Boolean(workflow.request));
	const [availableHeight, setAvailableHeight] = useState(384);
	const panel = useRef<HTMLDivElement | null>(null);
	const toggle = useRef<HTMLButtonElement | null>(null);
	const contentId = useId();
	// A team run is drawn in the transcript as a group chat instead of this inspector.
	const fusion = workflow.fusion?.models?.sidekick === "team" ? undefined : workflow.fusion;
	const hasContent = Boolean(workflow.request || workflow.todos.length || workflow.tasks.length || fusion);
	const { current, active } = currentStep(workflow.todos);
	const running = workflow.tasks.filter(task => task.status === "running").length;
	const summary = workflow.request?.title || active?.text || workflow.todos.find(todo => todo.status === "pending")?.text || workflow.tasks.find(task => task.status === "running")?.description || (fusion ? `Fusion · ${t(`fusion.engine.${fusion.status}`)}` : "");

	// A new question must be visible even when the user folded an earlier run.
	useEffect(() => { if (workflow.request) setOpen(true); }, [workflow.request?.id]);
	useLayoutEffect(() => {
		const element = panel.current;
		if (!open || !hasContent || !element) return;
		const measure = () => setAvailableHeight(Math.max(0, element.getBoundingClientRect().top - 12));
		measure();
		const observer = new ResizeObserver(measure);
		// Observe the whole composer: growing drafts move the attached rail upwards.
		observer.observe(element.parentElement?.parentElement ?? element);
		window.addEventListener("resize", measure);
		window.visualViewport?.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			window.visualViewport?.removeEventListener("resize", measure);
		};
	}, [open, hasContent]);

	if (!hasContent) return null;
	return (
		<ComposerStackedHeaderFrame className="relative z-20 text-[length:var(--app-font-size-ui,12px)]" data-slot="workflow-rail">
			<div ref={panel} data-composer-stacked-attached={open ? "true" : undefined}
				className={cn("chat-composer-stacked-top border", COMPOSER_STACKED_SURFACE_BORDER_CLASS_NAME)}
				onKeyDown={event => {
					if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); toggle.current?.focus(); }
				}}>
				{/* Absolute positioning keeps the input and transcript still while the body opens upwards. */}
				<div id={contentId} role="region" aria-label={t("workflow.title")} hidden={!open} data-slot="workflow-content"
					style={{ maxHeight: Math.min(384, availableHeight) }}
					className={cn("absolute inset-x-[-1px] bottom-full min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain rounded-t-xl border border-b-0 bg-popover/95 p-2 backdrop-blur-xl", COMPOSER_STACKED_SURFACE_BORDER_CLASS_NAME, COMPOSER_SURFACE_SHADOW_CLASS_NAME, open ? "flex" : "hidden")}>
					{fusion ? <FusionEngineInspector state={fusion} embedded /> : null}
					{workflow.request ? <QuestionCard key={workflow.request.id} request={workflow.request} onAnswer={onAnswer} /> : null}
					{workflow.todos.length || workflow.tasks.length ? <ProgressSection workflow={workflow} open={open} compact={Boolean(workflow.request)} onOpenTask={onOpenTask}
						onCancel={id => { void (onCancelWorker ?? api.agentCancelTask)(id).catch(cause => { setError(errorMessage(cause)); setOpen(true); }); }} /> : null}
					{error ? <p role="alert" className="shrink-0 break-words text-destructive">{error}</p> : null}
				</div>
				<button ref={toggle} type="button" aria-expanded={open} aria-controls={contentId} aria-label={t(open ? "workflow.collapse" : "workflow.expand")}
					onClick={() => setOpen(value => !value)}
					className="flex h-9 w-full min-w-0 items-center gap-2 rounded-t-[inherit] px-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
					{open ? <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronUpIcon className="size-3.5 shrink-0 text-muted-foreground" />}
					<span className="shrink-0 font-medium">{t("workflow.title")}</span>
					{workflow.todos.length ? <span className="shrink-0 tabular-nums text-muted-foreground" aria-label={t("workflow.stepOfTotal", { current, total: workflow.todos.length })}>{current}/{workflow.todos.length}</span> : null}
					<span className={cn("min-w-0 flex-1 truncate", workflow.request ? "text-foreground" : "text-muted-foreground")} title={summary}>{summary}</span>
					{workflow.tasks.length ? <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground" aria-label={t("workflow.workers", { running, max: workflow.maxWorkers ?? MAX_WORKERS })}><WorkerSlots running={running} max={workflow.maxWorkers} /><span className="tabular-nums">{running}/{workflow.maxWorkers ?? MAX_WORKERS}</span></span> : null}
				</button>
			</div>
		</ComposerStackedHeaderFrame>
	);
}
