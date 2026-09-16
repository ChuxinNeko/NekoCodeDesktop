import { useCallback, useEffect, useState } from "react";
import type { AutomationRun, AutomationSchedule, AutomationWithState } from "../../../../shared/automation";
import type { ModelOption } from "../../../../shared/agent";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslateFn, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { AutomationEditor, draftFrom, emptyDraft, toSaveRequest, type AutomationDraft } from "./AutomationEditor";
import {
	CircleAlertIcon,
	CircleCheckIcon,
	PauseIcon,
	PlayIcon,
	PlusIcon,
	RefreshCwIcon,
	StopIcon,
	TrashCanIcon,
	WorkflowIcon,
	XIcon,
} from "../../lib/icons";

function relativeTime(timestamp: number | undefined, t: TranslateFn): string {
	if (timestamp === undefined) return "—";
	const minutes = Math.round((Date.now() - timestamp) / 60_000);
	if (Math.abs(minutes) < 1) return t("automations.time.now");
	if (minutes < 0) {
		const ahead = -minutes;
		if (ahead < 60) return t("automations.time.inMinutes", { count: ahead });
		if (ahead < 60 * 24) return t("automations.time.inHours", { count: Math.round(ahead / 60) });
		return t("automations.time.inDays", { count: Math.round(ahead / (60 * 24)) });
	}
	if (minutes < 60) return t("automations.time.minutesAgo", { count: minutes });
	if (minutes < 60 * 24) {
		return t("automations.time.hoursAgo", { count: Math.round(minutes / 60) });
	}
	return t("automations.time.daysAgo", { count: Math.round(minutes / (60 * 24)) });
}

function scheduleText(schedule: AutomationSchedule, t: TranslateFn): string {
	switch (schedule.kind) {
		case "interval":
			return schedule.minutes % 60 === 0
				? t("automations.schedule.everyHours", { count: schedule.minutes / 60 })
				: t("automations.schedule.everyMinutes", { count: schedule.minutes });
		case "daily":
			return t("automations.schedule.daily", {
				time: `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`,
			});
		case "cron":
			return schedule.expression;
	}
}

const RUN_STATUS_LABEL_KEYS: Record<AutomationRun["status"], TranslationKey> = {
	running: "automations.status.running",
	succeeded: "automations.status.succeeded",
	failed: "automations.status.failed",
	aborted: "automations.status.aborted",
};

function RunStatusGlyph({ run }: { run: AutomationRun }) {
	switch (run.status) {
		case "running":
			return <Spinner className="size-3 text-muted-foreground" />;
		case "succeeded":
			return <CircleCheckIcon className="size-3 text-[var(--success)]" />;
		case "aborted":
			return <StopIcon className="size-3 text-muted-foreground" />;
		case "failed":
			return <CircleAlertIcon className="size-3 text-destructive" />;
	}
}

function AutomationRow({
	automation,
	selected,
	onSelect,
	onToggle,
	onRunNow,
	onAbort,
	onRemove,
}: {
	automation: AutomationWithState;
	selected: boolean;
	onSelect: () => void;
	onToggle: () => void;
	onRunNow: () => void;
	onAbort: () => void;
	onRemove: () => void;
}) {
	const { t } = useTranslation();
	const lastRun = automation.lastRun;
	return (
		<div
			className={cn(
				"flex flex-col gap-1 rounded-lg px-2.5 py-2 transition-colors",
				selected ? "bg-[var(--sidebar-selected)]" : "hover:bg-[var(--sidebar-accent)]",
			)}
		>
			<button className="flex items-center gap-1.5 text-left" onClick={onSelect} type="button">
				<WorkflowIcon
					className={cn(
						"size-3.5 shrink-0",
						automation.enabled ? "text-[var(--success)]" : MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				/>
				<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)]">
					{automation.name}
				</span>
				{lastRun ? <RunStatusGlyph run={lastRun} /> : null}
			</button>
			<div className={cn("flex items-center gap-2 text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
				<span className="shrink-0">{scheduleText(automation.schedule, t)}</span>
				<span className="shrink-0">
					{t("automations.next", { time: relativeTime(automation.nextRunAt ?? undefined, t) })}
				</span>
			</div>
			<div className="flex items-center gap-1">
				<Button onClick={onToggle} size="xs" variant="chrome-outline">
					{automation.enabled ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
					{automation.enabled ? t("automations.disable") : t("automations.enable")}
				</Button>
				{automation.running ? (
					<Button onClick={onAbort} size="xs" variant="destructive-outline">
						<StopIcon className="size-3" />
						{t("automations.abort")}
					</Button>
				) : (
					<Button onClick={onRunNow} size="xs" variant="chrome-outline">
						<PlayIcon className="size-3" />
						{t("automations.runNow")}
					</Button>
				)}
				<div className="flex-1" />
				<Button onClick={onRemove} size="icon-xs" variant="destructive-outline">
					<TrashCanIcon className="size-3.5" />
				</Button>
			</div>
		</div>
	);
}

export function AutomationsPage({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
	const { t } = useTranslation();
	const [automations, setAutomations] = useState<AutomationWithState[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [runs, setRuns] = useState<AutomationRun[]>([]);
	const [draft, setDraft] = useState<AutomationDraft | null>(null);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const selected = automations.find((entry) => entry.id === selectedId) ?? null;

	const refresh = useCallback(async () => {
		try {
			const list = await api.automationList();
			setAutomations(list);
			setSelectedId((current) =>
				current !== null && list.some((entry) => entry.id === current)
					? current
					: (list[0]?.id ?? null),
			);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// The scheduler runs in the main process; refresh on its events so the panel
	// shows run state without polling.
	useEffect(() => {
		return api.onAutomationEvent(() => {
			void refresh();
		});
	}, [refresh]);

	useEffect(() => {
		// Models come from the active agent session; without one, fall back to none.
		void api
			.agentSnapshot()
			.then((snapshot) => setModels(snapshot?.models ?? []))
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		if (!selectedId) {
			setRuns([]);
			return;
		}
		let cancelled = false;
		void api.automationRuns(selectedId).then((list) => {
			if (!cancelled) setRuns(list);
		});
		return () => {
			cancelled = true;
		};
	}, [selectedId, automations]);

	const save = async () => {
		if (!draft || !cwd) return;
		setBusy(true);
		setError(null);
		try {
			const saved = await api.automationSave(toSaveRequest(draft, cwd));
			setDraft(null);
			setSelectedId(saved.id);
			await refresh();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const runNow = async (id: string) => {
		setError(null);
		try {
			await api.automationRunNow(id);
			await refresh();
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
				<WorkflowIcon className="size-3.5" />
				<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">{t("nav.automations")}</span>
				<span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
					{t("automations.enabledCount", {
						enabled: automations.filter((entry) => entry.enabled).length,
						total: automations.length,
					})}
				</span>
				<div className="flex-1" />
				<Button
					disabled={!cwd}
					onClick={() => setDraft(emptyDraft())}
					size="xs"
					variant="chrome-outline"
				>
					<PlusIcon className="size-3.5" />
					{t("common.new")}
				</Button>
				<Button onClick={() => void refresh()} size="icon-xs" variant="ghost">
					<RefreshCwIcon className="size-3.5" />
				</Button>
				<Button onClick={onClose} size="icon-xs" variant="ghost">
					<XIcon className="size-3.5" />
				</Button>
			</header>

			{error ? (
				<div className="border-b border-[color:var(--app-surface-divider)] px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					{error}
				</div>
			) : null}

			<div className="flex min-h-0 flex-1">
				<div className="flex w-80 min-w-0 shrink-0 flex-col gap-1 overflow-y-auto border-r border-[color:var(--app-surface-divider)] p-1.5">
					{automations.length === 0 ? (
						<p className="px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							{t("automations.empty")}
						</p>
					) : (
						automations.map((automation) => (
							<AutomationRow
								automation={automation}
								key={automation.id}
								onAbort={() => void api.automationAbort(automation.id).then(refresh)}
								onRemove={() => void api.automationRemove(automation.id).then(refresh)}
								onRunNow={() => void runNow(automation.id)}
								onSelect={() => setSelectedId(automation.id)}
								onToggle={() =>
									void api
										.automationSave({
											id: automation.id,
											name: automation.name,
											cwd: automation.cwd,
											prompt: automation.prompt,
											modelKey: automation.modelKey,
											mode: automation.mode,
											schedule: automation.schedule,
											enabled: !automation.enabled,
										})
										.then(refresh)
								}
								selected={automation.id === selectedId}
							/>
						))
					)}
				</div>

				<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
					{draft ? (
						<AutomationEditor
							cwd={cwd}
							draft={draft}
							models={models}
							onCancel={() => setDraft(null)}
							onChange={setDraft}
							onSave={() => void save()}
						/>
					) : null}

					{selected ? (
						<>
							<div className="flex flex-col gap-1">
								<div className="flex items-center gap-2">
									<h2 className="min-w-0 flex-1 text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
										{selected.name}
									</h2>
									<Button
										onClick={() => setDraft(draftFrom(selected))}
										size="xs"
										variant="chrome-outline"
									>
										{t("common.edit")}
									</Button>
								</div>
								<p className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
									{scheduleText(selected.schedule, t)} · {selected.mode} ·{" "}
									{t("automations.next", {
										time: relativeTime(selected.nextRunAt ?? undefined, t),
									})}{" "}
									· {selected.cwd}
								</p>
							</div>

							<div className="flex flex-col gap-1">
								<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
									{t("common.prompt")}
								</span>
								<pre className="whitespace-pre-wrap rounded-lg border border-border p-2.5 text-[length:var(--app-font-size-ui-sm,11px)]">
									{selected.prompt}
								</pre>
							</div>

							<div className="flex flex-col gap-2">
								<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
									{t("automations.runHistory", { count: runs.length })}
								</span>
								{runs.length === 0 ? (
									<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
										{t("automations.noRuns")}
									</p>
								) : (
									runs.map((run) => (
										<div
											className="flex flex-col gap-1 rounded-lg border border-border p-2.5"
											key={run.id}
										>
											<div className="flex items-center gap-1.5">
												<RunStatusGlyph run={run} />
												<span className="text-[length:var(--app-font-size-ui-sm,11px)] font-medium">
													{t(RUN_STATUS_LABEL_KEYS[run.status])}
												</span>
												<span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
													{relativeTime(run.startedAt, t)}
													{run.finishedAt === undefined
														? ""
														: ` · ${String(Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000)))}s`}
													{` · ${t("automations.toolCalls", { count: run.toolCalls })}`}
												</span>
											</div>
											{run.error ? (
												<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
													{run.error}
												</p>
											) : null}
											{run.summary ? (
												<pre className="max-h-64 overflow-auto whitespace-pre-wrap text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
													{run.summary}
												</pre>
											) : null}
										</div>
									))
								)}
							</div>
						</>
					) : !draft ? (
						<div className="flex flex-1 items-center justify-center">
							<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
								{t("automations.select")}
							</p>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
