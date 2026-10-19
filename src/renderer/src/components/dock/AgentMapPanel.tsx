import { useState, type ReactNode } from "react";
import type { AgentSnapshot } from "../../../../shared/agent";
import type { ExplorerRun, WorkflowTask, WorkflowTodo } from "../../../../shared/workflow";
import { useTranslation, type TranslationKey } from "../../i18n";
import {
	mainActivity,
	stepCounts,
	subagentActivity,
	summarizeTurn,
	type MainActivity,
	type SubagentActivity,
} from "../../lib/agentActivity";
import { elapsedSeconds, formatElapsed, useNow } from "../../lib/elapsed";
import { AgentMapIcon, ArrowLeftIcon, BotIcon, CheckIcon, SearchIcon, TriangleAlertIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { Spinner } from "../ui/spinner";
import { Button } from "../ui/button";
import { AgentMapCanvas, type AgentMapNode } from "./AgentMapCanvas";
import { TaskDetailPanel } from "./TaskDetailPanel";

/** Finished subagents shown beside the main agent; older ones are counted. */
const MAX_FINISHED_SHOWN = 6;

type Tone = "active" | "attention" | "idle" | "done" | "failed";

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

function toneOfStatus(status: WorkflowTask["status"]): Tone {
	return status === "running" ? "active" : status === "completed" ? "done" : status === "failed" ? "failed" : "idle";
}

/** A node's state at a glance: a pulse while it works, a mark once it is done. */
function StatusMark({ tone }: { tone: Tone }) {
	if (tone === "done") return <CheckIcon className="size-3.5 shrink-0 text-[var(--success,#16a34a)]" />;
	if (tone === "failed") return <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />;
	return (
		<span className="relative flex size-2.5 shrink-0 items-center justify-center" aria-hidden="true">
			{tone === "active" ? <span className="agent-map-pulse absolute inset-0 rounded-full bg-[var(--color-token-text-link-foreground)]" /> : null}
			<span
				className={cn(
					"relative size-2 rounded-full",
					tone === "active" && "bg-[var(--color-token-text-link-foreground)]",
					tone === "attention" && "bg-[var(--warning,#d97706)]",
					tone === "idle" && "bg-muted-foreground/40",
				)}
			/>
		</span>
	);
}

function Elapsed({ since, until, live }: { since: number; until?: number; live: boolean }) {
	const now = useNow(live);
	return <span className="shrink-0 tabular-nums">{formatElapsed(elapsedSeconds(since, until ?? now))}</span>;
}

/** The line under a node's title that says what it is doing now. */
function ActivityLine({ tone, children, since, live }: { tone: Tone; children: ReactNode; since?: number; live: boolean }) {
	return (
		<div
			className={cn(
				"flex min-w-0 items-center gap-1.5 text-[length:var(--app-font-size-ui,12px)]",
				tone === "attention" ? "text-[var(--warning,#d97706)]" : tone === "failed" ? "text-destructive" : "text-foreground",
			)}
		>
			{tone === "active" && since !== undefined ? <Spinner className="size-3 shrink-0 text-muted-foreground" /> : null}
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{since !== undefined ? (
				<span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
					<Elapsed since={since} live={live} />
				</span>
			) : null}
		</div>
	);
}

function Meta({ children }: { children: ReactNode }) {
	return (
		<div className={cn("flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-[color:var(--app-surface-divider)] pt-2 text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
			{children}
		</div>
	);
}

function NodeCard({ tone, children }: { tone: Tone; children: ReactNode }) {
	return <div className="agent-map-card flex min-w-0 flex-col gap-2 overflow-hidden rounded-2xl border p-3.5 text-left" data-tone={tone}>{children}</div>;
}

function StatusBadge({ tone }: { tone: Tone }) {
	const { t } = useTranslation();
	const label: Record<Tone, TranslationKey> = { active: "workflow.running", done: "workflow.completed", failed: "workflow.failed", idle: "agentMap.idle", attention: "agentMap.needsInput" };
	return <span className="agent-map-status inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[10px] leading-none" data-tone={tone}><StatusMark tone={tone} />{t(label[tone])}</span>;
}

function mainTone(activity: MainActivity): Tone {
	return activity.kind === "idle" ? "idle" : activity.kind === "question" ? "attention" : "active";
}

function MainActivityText({ activity }: { activity: MainActivity }) {
	const { t } = useTranslation();
	switch (activity.kind) {
		case "tool":
			return <>{t("agentMap.activity.executing")}</>;
		case "idle":
			return <>{t("agentMap.activity.idle")}</>;
		case "question":
			return <>{t("agentMap.activity.question")}</>;
		case "waiting":
			return <>{t("agentMap.activity.waiting")}</>;
		case "thinking":
			return <>{t("agentMap.activity.thinking")}</>;
		case "replying":
			return <>{t("agentMap.activity.replying")}</>;
	}
}

function TodoProgress({ todos }: { todos: readonly WorkflowTodo[] }) {
	const { t } = useTranslation();
	const counted = todos.filter((todo) => todo.status !== "cancelled");
	if (counted.length === 0) return null;
	const done = counted.filter((todo) => todo.status === "completed").length;
	const current = counted.find((todo) => todo.status === "in_progress");
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2 text-[length:var(--app-font-size-ui-xs,10px)]">
				<span className={MUTED_LABEL_TEXT_CLASS_NAME}>{t("agentMap.todos", { done, total: counted.length })}</span>
				<span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10">
					<span
						className="block h-full rounded-full bg-[var(--color-token-text-link-foreground)] transition-[width] duration-300"
						style={{ width: `${(done / counted.length) * 100}%` }}
					/>
				</span>
			</div>
			{current ? <div className="truncate text-[length:var(--app-font-size-ui-sm,11px)]">▸ {current.text}</div> : null}
		</div>
	);
}

function MainNode({ snapshot }: { snapshot: AgentSnapshot }) {
	const { t } = useTranslation();
	const activity = mainActivity(snapshot.cells, snapshot.streaming, snapshot.workflow.request !== null);
	const turn = summarizeTurn(snapshot.cells);
	const tone = mainTone(activity);
	const model = snapshot.modelKey?.split("/").slice(1).join("/") || snapshot.modelKey;
	const mode =
		snapshot.workMode === "agent"
			? `${t("workMode.agent")} · ${t(`agentPhase.${snapshot.agentPhase}` as TranslationKey)}`
			: t(`workMode.${snapshot.workMode}` as TranslationKey);
	const since = activity.kind === "idle" || activity.kind === "question" ? undefined : activity.since;
	return (
		<NodeCard tone={tone}>
			<div className="flex min-w-0 items-center gap-2">
				<span className="agent-map-avatar flex size-9 shrink-0 items-center justify-center rounded-xl"><BotIcon className="size-5" /></span>
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13px] font-semibold">{t("agentMap.main")}</div>
					<div className="truncate text-[10px] text-muted-foreground" title={model ?? undefined}>{model || t("agentMap.modelUnknown")}</div>
				</div>
				<StatusBadge tone={tone} />
			</div>
			<div className="text-[10px] text-muted-foreground">{mode}</div>
			<ActivityLine tone={tone} since={since} live={snapshot.streaming}>
				<MainActivityText activity={activity} />
			</ActivityLine>
			<TodoProgress todos={snapshot.workflow.todos} />
			{turn.startedAt !== null ? (
				<Meta>
					<span>
						{t("agentMap.turn")} <Elapsed since={turn.startedAt} live={snapshot.streaming} until={snapshot.streaming ? undefined : lastTimestamp(snapshot)} />
					</span>
					<span>{t("agentMap.toolCalls", { count: turn.toolCalls })}</span>
					{turn.errors ? <span className="text-destructive">{t("agentMap.errors", { count: turn.errors })}</span> : null}
				</Meta>
			) : null}
		</NodeCard>
	);
}

/** When the last thing in the transcript happened — where a finished turn's clock stops. */
function lastTimestamp(snapshot: AgentSnapshot): number | undefined {
	return snapshot.cells[snapshot.cells.length - 1]?.timestamp;
}

function SubagentActivityText({ activity, status }: { activity: SubagentActivity; status: WorkflowTask["status"] }) {
	const { t } = useTranslation();
	switch (activity.kind) {
		case "tool":
			return <>{t("agentMap.activity.executing")}</>;
		case "thinking":
			return <>{t("agentMap.activity.thinking")}</>;
		case "said":
			return <span className="italic">“{activity.text}”</span>;
		case "starting":
			return <>{t("agentMap.activity.starting")}</>;
		case "finished":
			return <>{t(STATUS_KEYS[status])}</>;
	}
}

function SubagentNode({
	title,
	label,
	icon,
	run,
	extra,
	onOpen,
	model,
}: {
	title: string;
	label: string;
	icon: ReactNode;
	run: WorkflowTask | ExplorerRun;
	extra?: ReactNode;
	onOpen?: () => void;
	model?: string;
}) {
	const { t } = useTranslation();
	const activity = subagentActivity(run);
	const tone = toneOfStatus(run.status);
	const counts = stepCounts(run.steps);
	const since = activity.kind === "tool" || activity.kind === "thinking" ? activity.since : undefined;
	return (
		<NodeCard tone={tone}>
			<div className="flex min-w-0 items-center gap-2">
				<span className="agent-map-avatar flex size-9 shrink-0 items-center justify-center rounded-xl">{icon}</span>
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13px] font-semibold">{label}</div>
					<div className="truncate text-[10px] text-muted-foreground" title={model}>{model?.split("/").slice(1).join("/") || model || t("agentMap.delegated")}</div>
				</div>
				<StatusBadge tone={tone} />
			</div>
			<p className="line-clamp-2 break-words text-[12px] leading-4 text-foreground" title={title}>{title}</p>
			<ActivityLine tone={tone === "failed" ? "failed" : tone} since={since} live={run.status === "running"}>
				<SubagentActivityText activity={activity} status={run.status} />
			</ActivityLine>
			<Meta>
				<Elapsed since={run.startedAt} until={run.endedAt} live={run.status === "running"} />
				<span>{t("agentMap.toolCalls", { count: counts.tools })}</span>
				{counts.errors ? <span className="text-destructive">{t("agentMap.errors", { count: counts.errors })}</span> : null}
				{extra}
				{onOpen ? <span className="ml-auto text-[var(--color-token-text-link-foreground)]">{t("agentMap.openDetails")} →</span> : null}
			</Meta>
		</NodeCard>
	);
}

type Child = { kind: "task"; task: WorkflowTask } | { kind: "explorer"; run: ExplorerRun };

/** Running first, oldest first so the tree does not reshuffle as they report; then the latest finished. */
function orderChildren(tasks: readonly WorkflowTask[], explorers: readonly ExplorerRun[]): { shown: Child[]; hidden: number } {
	const all: Child[] = [
		...tasks.map((task) => ({ kind: "task" as const, task })),
		...explorers.map((run) => ({ kind: "explorer" as const, run })),
	];
	const run = (child: Child) => (child.kind === "task" ? child.task : child.run);
	const running = all.filter((child) => run(child).status === "running").sort((a, b) => run(a).startedAt - run(b).startedAt);
	const finished = all
		.filter((child) => run(child).status !== "running")
		.sort((a, b) => (run(b).endedAt ?? run(b).startedAt) - (run(a).endedAt ?? run(a).startedAt));
	return { shown: [...running, ...finished.slice(0, MAX_FINISHED_SHOWN)], hidden: Math.max(0, finished.length - MAX_FINISHED_SHOWN) };
}

/**
 * What the agents in this session are doing: the main agent above a staggered
 * vertical stack of workers and explorers, joined by branches on the left.
 *
 * Everything here is live state the transcript already has; the map is a
 * second way of reading it, organised by who is doing what rather than by
 * when it was said.
 */
export function AgentMapPanel({ snapshot, onOpenTask }: { snapshot: AgentSnapshot | null; onOpenTask?: (taskId: string) => void }) {
	const { t } = useTranslation();
	const [selection, setSelection] = useState<{ sessionId: string; kind: Child["kind"]; id: string } | null>(null);
	const selected = selection?.sessionId === snapshot?.session.id ? selection : null;
	const selectedTask = selected?.kind === "task" ? snapshot?.workflow.tasks.find(task => task.id === selected.id) : null;
	const selectedExplorer = selected?.kind === "explorer" ? snapshot?.workflow.explorers?.find(run => run.id === selected.id) : null;
	const detail: WorkflowTask | null = selectedTask ?? (selectedExplorer ? {
		id: selectedExplorer.id, description: selectedExplorer.query, kind: "explore", writablePaths: [],
		status: selectedExplorer.status, startedAt: selectedExplorer.startedAt, endedAt: selectedExplorer.endedAt, steps: selectedExplorer.steps,
	} : null);
	const { shown, hidden } = snapshot ? orderChildren(snapshot.workflow.tasks, snapshot.workflow.explorers ?? []) : { shown: [], hidden: 0 };
	const runs = snapshot ? [...snapshot.workflow.tasks, ...(snapshot.workflow.explorers ?? [])] : [];
	const running = runs.filter(run => run.status === "running").length + (snapshot?.streaming ? 1 : 0);
	const failed = runs.filter(run => run.status === "failed").length;
	const nodes: AgentMapNode[] = shown.map(child => {
		const run = child.kind === "task" ? child.task : child.run;
		const open = () => {
			if (child.kind === "task" && onOpenTask) onOpenTask(child.task.id);
			else if (snapshot) setSelection({ sessionId: snapshot.session.id, kind: child.kind, id: run.id });
		};
		return {
			id: `${child.kind}:${run.id}`,
			label: child.kind === "task" ? child.task.description : child.run.query,
			tone: toneOfStatus(run.status),
			onOpen: open,
			content: child.kind === "task" ? (
				<SubagentNode title={child.task.description} label={t(KIND_KEYS[child.task.kind])}
					icon={<BotIcon className="size-5" />} run={child.task}
					extra={child.task.writablePaths.length ? <span className="max-w-full truncate font-mono" title={child.task.writablePaths.join(", ")}>✎ {child.task.writablePaths.slice(0, 2).join(", ")}{child.task.writablePaths.length > 2 ? ` +${child.task.writablePaths.length - 2}` : ""}</span> : null}
					onOpen={open} />
			) : <SubagentNode title={child.run.query} label={t("agentMap.explorer")} icon={<SearchIcon className="size-5" />} run={child.run} model={child.run.model} onOpen={open} />,
		};
	});
	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
			<div className={cn("flex min-h-0 flex-1 flex-col", selected && "invisible pointer-events-none")} inert={selected ? true : undefined}>
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
				<AgentMapIcon className="size-4 shrink-0 text-muted-foreground" />
				<h2 className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] font-medium">{t("agentMap.title")}</h2>
				{snapshot ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground">{t("agentMap.agentCount", { count: runs.length + 1 })}</span> : null}
			</header>
			{snapshot ? <>
				<div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3 py-2 text-[10px] text-muted-foreground">
					<span className="min-w-0 flex-1 truncate" title={snapshot.session.title}>{snapshot.session.titlePending ? t("sessions.pendingTitle") : snapshot.session.title}</span>
					{running > 0 ? <span className="agent-map-status rounded-full px-2 py-1 leading-none" data-tone="active">{t("agentMap.runningCount", { count: running })}</span> : null}
					{failed > 0 ? <span className="agent-map-status rounded-full px-2 py-1 leading-none" data-tone="failed">{t("agentMap.failedCount", { count: failed })}</span> : null}
				</div>
				<div className="flex min-h-0 flex-1 flex-col">
					<AgentMapCanvas key={snapshot.session.id} main={<MainNode snapshot={snapshot} />}>{nodes}</AgentMapCanvas>
				</div>
				<footer className="shrink-0 border-t border-[color:var(--app-surface-divider)] px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
					<p>{t("agentMap.dragHint")}</p>
					{shown.length === 0 ? <p className="mt-1">{t("agentMap.noSubagents")}</p> : null}
					{hidden ? <p>{t("agentMap.earlier", { count: hidden })}</p> : null}
				</footer>
			</> : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
				<AgentMapIcon className="size-8 text-muted-foreground/50" />
				<p className="max-w-xs text-[12px] leading-relaxed text-muted-foreground">{t("agentMap.empty")}</p>
			</div>}
			</div>
			{selected ? <section className="absolute inset-0 z-10 flex min-h-0 flex-col bg-[var(--color-background-surface)]" aria-label={t("agentMap.openDetails")}>
				<header className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
					<Button autoFocus size="xs" variant="ghost" onClick={() => setSelection(null)}><ArrowLeftIcon className="size-3.5" />{t("agentMap.backToMap")}</Button>
					<h2 className="min-w-0 flex-1 truncate text-[12px] font-medium">{selected.kind === "explorer" ? t("agentMap.explorer") : t("dock.subagent")}</h2>
				</header>
				<TaskDetailPanel task={detail} />
			</section> : null}
		</div>
	);
}
