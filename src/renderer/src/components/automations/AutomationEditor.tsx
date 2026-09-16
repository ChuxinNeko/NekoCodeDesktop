import { useEffect, useMemo, useState } from "react";
import type {
	AutomationSchedule,
	AutomationWithState,
	SaveAutomationRequest,
} from "../../../../shared/automation";
import { normalizeSchedule } from "../../../../shared/automation";
import { nextOccurrence } from "../../../../shared/automationSchedule";
import type { ExecutionMode, ModelOption } from "../../../../shared/agent";
import { errorMessage } from "../../api";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";

type ScheduleKind = AutomationSchedule["kind"];

const KIND_LABELS: Record<ScheduleKind, string> = {
	interval: "Interval",
	daily: "Daily",
	cron: "Cron",
};

const MODE_LABELS: Record<ExecutionMode, string> = {
	"read-only": "Read only",
	auto: "Auto",
	"full-access": "Full access",
};

export interface AutomationDraft {
	id?: string;
	name: string;
	prompt: string;
	modelKey: string | null;
	mode: ExecutionMode;
	kind: ScheduleKind;
	intervalMinutes: number;
	dailyHour: number;
	dailyMinute: number;
	cronExpression: string;
	enabled: boolean;
}

export function draftFrom(automation: AutomationWithState): AutomationDraft {
	const schedule = automation.schedule;
	return {
		id: automation.id,
		name: automation.name,
		prompt: automation.prompt,
		modelKey: automation.modelKey,
		mode: automation.mode,
		kind: schedule.kind,
		intervalMinutes: schedule.kind === "interval" ? schedule.minutes : 60,
		dailyHour: schedule.kind === "daily" ? schedule.hour : 9,
		dailyMinute: schedule.kind === "daily" ? schedule.minute : 0,
		cronExpression: schedule.kind === "cron" ? schedule.expression : "0 9 * * 1-5",
		enabled: automation.enabled,
	};
}

export function emptyDraft(): AutomationDraft {
	return {
		name: "",
		prompt: "",
		modelKey: null,
		mode: "auto",
		kind: "interval",
		intervalMinutes: 60,
		dailyHour: 9,
		dailyMinute: 0,
		cronExpression: "0 9 * * 1-5",
		enabled: false,
	};
}

function scheduleFromDraft(draft: AutomationDraft): AutomationSchedule {
	switch (draft.kind) {
		case "interval":
			return { kind: "interval", minutes: draft.intervalMinutes };
		case "daily":
			return { kind: "daily", hour: draft.dailyHour, minute: draft.dailyMinute };
		case "cron":
			return { kind: "cron", expression: draft.cronExpression };
	}
}

export function toSaveRequest(draft: AutomationDraft, cwd: string): SaveAutomationRequest {
	return {
		...(draft.id ? { id: draft.id } : {}),
		name: draft.name,
		cwd,
		prompt: draft.prompt,
		modelKey: draft.modelKey,
		mode: draft.mode,
		schedule: scheduleFromDraft(draft),
		enabled: draft.enabled,
	};
}

/** Live preview of the next fire time, so a bad cron expression is visible before saving. */
function useSchedulePreview(draft: AutomationDraft): { next: Date | null; error: string | null } {
	return useMemo(() => {
		try {
			const schedule = normalizeSchedule(scheduleFromDraft(draft));
			return { next: nextOccurrence(schedule, new Date()), error: null };
		} catch (cause) {
			return { next: null, error: errorMessage(cause) };
		}
	}, [draft]);
}

export function AutomationEditor({
	draft,
	cwd,
	models,
	onChange,
	onCancel,
	onSave,
}: {
	draft: AutomationDraft;
	cwd: string | null;
	models: ModelOption[];
	onChange: (draft: AutomationDraft) => void;
	onCancel: () => void;
	onSave: () => void;
}) {
	const preview = useSchedulePreview(draft);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setError(null);
	}, [draft]);

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border p-3">
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1">
					<Label>Name</Label>
					<Input
						value={draft.name}
						onChange={(event) => onChange({ ...draft, name: event.target.value })}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label>Execution mode</Label>
					<select
						className="h-8 rounded-lg border border-border bg-transparent px-2 text-[length:var(--app-font-size-ui,12px)]"
						onChange={(event) => onChange({ ...draft, mode: event.target.value as ExecutionMode })}
						value={draft.mode}
					>
						{Object.entries(MODE_LABELS).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</div>
			</div>

			<div className="flex flex-col gap-1">
				<Label>Prompt</Label>
				<Textarea
					rows={5}
					value={draft.prompt}
					onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
				/>
			</div>

			<div className="flex flex-col gap-1">
				<Label>Model</Label>
				<select
					className="h-8 rounded-lg border border-border bg-transparent px-2 text-[length:var(--app-font-size-ui,12px)]"
					onChange={(event) =>
						onChange({ ...draft, modelKey: event.target.value === "" ? null : event.target.value })
					}
					value={draft.modelKey ?? ""}
				>
					<option value="">Runtime default</option>
					{models.map((model) => (
						<option key={model.key} value={model.key}>
							{model.name} ({model.provider})
						</option>
					))}
				</select>
			</div>

			<div className="flex flex-col gap-2">
				<Label>Schedule</Label>
				<div className="flex items-center gap-0.5 rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5">
					{(Object.keys(KIND_LABELS) as ScheduleKind[]).map((kind) => (
						<button
							key={kind}
							type="button"
							onClick={() => onChange({ ...draft, kind })}
							className={cn(
								"rounded-sm px-2 py-0.5 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
								draft.kind === kind
									? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)]"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{KIND_LABELS[kind]}
						</button>
					))}
				</div>

				{draft.kind === "interval" ? (
					<div className="flex items-center gap-2">
						<Input
							className="w-24"
							onChange={(event) =>
								onChange({ ...draft, intervalMinutes: Number(event.target.value) || 1 })
							}
							type="number"
							value={draft.intervalMinutes}
						/>
						<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							minutes
						</span>
					</div>
				) : draft.kind === "daily" ? (
					<div className="flex items-center gap-2">
						<Input
							className="w-20"
							onChange={(event) =>
								onChange({ ...draft, dailyHour: Number(event.target.value) || 0 })
							}
							type="number"
							value={draft.dailyHour}
						/>
						<span className="text-muted-foreground">:</span>
						<Input
							className="w-20"
							onChange={(event) =>
								onChange({ ...draft, dailyMinute: Number(event.target.value) || 0 })
							}
							type="number"
							value={draft.dailyMinute}
						/>
						<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							local time
						</span>
					</div>
				) : (
					<div className="flex flex-col gap-1">
						<Input
							className="font-mono"
							onChange={(event) => onChange({ ...draft, cronExpression: event.target.value })}
							placeholder="0 9 * * 1-5"
							value={draft.cronExpression}
						/>
						<span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
							5 fields: minute hour day-of-month month day-of-week. Supports * , - and /.
						</span>
					</div>
				)}

				<span
					className={cn(
						"text-[length:var(--app-font-size-ui-sm,11px)]",
						preview.error ? "text-destructive" : MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					{preview.error
						? preview.error
						: preview.next
							? `Next run: ${preview.next.toLocaleString()}`
							: "No upcoming run in the next four years."}
				</span>
			</div>

			<label className="flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)]">
				<input
					checked={draft.enabled}
					onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
					type="checkbox"
				/>
				Enabled (the scheduler only fires enabled automations)
			</label>

			{!cwd ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					打开一个项目目录后才能保存自动化。
				</p>
			) : null}
			{error ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p>
			) : null}

			<div className="flex items-center gap-2">
				<div className="flex-1" />
				<Button onClick={onCancel} size="sm" variant="ghost">
					Cancel
				</Button>
				<Button
					disabled={!cwd || preview.error !== null}
					onClick={() => {
						try {
							onSave();
						} catch (cause) {
							setError(errorMessage(cause));
						}
					}}
					size="sm"
					variant="subtle"
				>
					Save
				</Button>
			</div>
		</div>
	);
}
