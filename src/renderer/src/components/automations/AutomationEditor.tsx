import { useEffect, useMemo, useState } from "react";
import type {
	AutomationSchedule,
	AutomationWithState,
	SaveAutomationRequest,
} from "../../../../shared/automation";
import { normalizeSchedule } from "../../../../shared/automation";
import { nextOccurrence } from "../../../../shared/automationSchedule";
import { modelLabel, type ExecutionMode, type ModelOption } from "../../../../shared/agent";
import { errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";

type ScheduleKind = AutomationSchedule["kind"];

const KIND_LABEL_KEYS: Record<ScheduleKind, TranslationKey> = {
	interval: "automations.editor.kind.interval",
	daily: "automations.editor.kind.daily",
	cron: "automations.editor.kind.cron",
};

const MODE_LABEL_KEYS: Record<ExecutionMode, TranslationKey> = {
	"read-only": "mode.read-only",
	auto: "mode.auto",
	"full-access": "mode.full-access",
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
	const { t } = useTranslation();
	const preview = useSchedulePreview(draft);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setError(null);
	}, [draft]);

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border p-3">
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1">
					<Label>{t("common.name")}</Label>
					<Input
						value={draft.name}
						onChange={(event) => onChange({ ...draft, name: event.target.value })}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label>{t("automations.editor.executionMode")}</Label>
					<select
						className="h-8 rounded-lg border border-border bg-transparent px-2 text-[length:var(--app-font-size-ui,12px)]"
						onChange={(event) => onChange({ ...draft, mode: event.target.value as ExecutionMode })}
						value={draft.mode}
					>
						{(Object.keys(MODE_LABEL_KEYS) as ExecutionMode[]).map((value) => (
							<option key={value} value={value}>
								{t(MODE_LABEL_KEYS[value])}
							</option>
						))}
					</select>
				</div>
			</div>

			<div className="flex flex-col gap-1">
				<Label>{t("common.prompt")}</Label>
				<Textarea
					rows={5}
					value={draft.prompt}
					onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
				/>
			</div>

			<div className="flex flex-col gap-1">
				<Label>{t("common.model")}</Label>
				<select
					className="h-8 rounded-lg border border-border bg-transparent px-2 text-[length:var(--app-font-size-ui,12px)]"
					onChange={(event) =>
						onChange({ ...draft, modelKey: event.target.value === "" ? null : event.target.value })
					}
					value={draft.modelKey ?? ""}
				>
					<option value="">{t("automations.editor.runtimeDefault")}</option>
					{models.map((model) => (
						<option key={model.key} value={model.key}>
							{modelLabel(model)}
						</option>
					))}
				</select>
			</div>

			<div className="flex flex-col gap-2">
				<Label>{t("automations.editor.schedule")}</Label>
				<div className="flex items-center gap-0.5 rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5">
					{(Object.keys(KIND_LABEL_KEYS) as ScheduleKind[]).map((kind) => (
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
							{t(KIND_LABEL_KEYS[kind])}
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
							{t("automations.editor.minutes")}
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
							{t("automations.editor.localTime")}
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
							{t("automations.editor.cronHint")}
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
							? t("automations.editor.nextRun", { time: preview.next.toLocaleString() })
							: t("automations.editor.noUpcoming")}
				</span>
			</div>

			<label className="flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)]">
				<input
					checked={draft.enabled}
					onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
					type="checkbox"
				/>
				{t("automations.editor.enabledHint")}
			</label>

			{!cwd ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					{t("automations.editor.noCwd")}
				</p>
			) : null}
			{error ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p>
			) : null}

			<div className="flex items-center gap-2">
				<div className="flex-1" />
				<Button onClick={onCancel} size="sm" variant="ghost">
					{t("common.cancel")}
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
					{t("common.save")}
				</Button>
			</div>
		</div>
	);
}
