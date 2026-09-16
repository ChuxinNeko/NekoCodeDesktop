/** Automation panel contracts: scheduled agent runs. */

import type { ExecutionMode } from "./agent";

export type AutomationSchedule =
	| { kind: "interval"; minutes: number }
	| { kind: "daily"; hour: number; minute: number }
	| { kind: "cron"; expression: string };

export type AutomationRunStatus = "running" | "succeeded" | "failed" | "aborted";

export interface Automation {
	id: string;
	name: string;
	/** Project directory the run happens in. */
	cwd: string;
	prompt: string;
	/** `provider/id`, or null to use whatever the runtime picks. */
	modelKey: string | null;
	mode: ExecutionMode;
	schedule: AutomationSchedule;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface AutomationRun {
	id: string;
	automationId: string;
	startedAt: number;
	finishedAt?: number;
	status: AutomationRunStatus;
	/** Last assistant message, truncated; what the run actually produced. */
	summary: string;
	sessionFile?: string;
	error?: string;
	toolCalls: number;
}

export interface AutomationWithState extends Automation {
	nextRunAt: number | null;
	lastRun: AutomationRun | null;
	running: boolean;
}

export interface SaveAutomationRequest {
	id?: string;
	name: string;
	cwd: string;
	prompt: string;
	modelKey: string | null;
	mode: ExecutionMode;
	schedule: AutomationSchedule;
	enabled: boolean;
}

export interface AutomationEvent {
	kind: "changed" | "run-started" | "run-finished";
	automationId: string;
}

const MAX_NAME = 120;
const MAX_PROMPT = 20_000;

/** Validate and normalize a schedule coming from the renderer. */
export function normalizeSchedule(value: unknown): AutomationSchedule {
	if (typeof value !== "object" || value === null) {
		throw new Error("schedule 必须是对象");
	}
	const schedule = value as Record<string, unknown>;
	switch (schedule.kind) {
		case "interval": {
			const minutes = Number(schedule.minutes);
			if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 7) {
				throw new Error("间隔必须是 1 分钟到 7 天之间");
			}
			return { kind: "interval", minutes: Math.round(minutes) };
		}
		case "daily": {
			const hour = Number(schedule.hour);
			const minute = Number(schedule.minute);
			if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("小时必须是 0-23");
			if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("分钟必须是 0-59");
			return { kind: "daily", hour, minute };
		}
		case "cron": {
			if (typeof schedule.expression !== "string") throw new Error("cron 表达式必须是字符串");
			return { kind: "cron", expression: schedule.expression.trim() };
		}
		default:
			throw new Error(`未知的 schedule.kind: ${String(schedule.kind)}`);
	}
}

export function validateAutomationInput(request: SaveAutomationRequest): void {
	const name = request.name.trim();
	if (name.length === 0) throw new Error("名称不能为空");
	if (name.length > MAX_NAME) throw new Error("名称过长");
	const prompt = request.prompt.trim();
	if (prompt.length === 0) throw new Error("提示词不能为空");
	if (prompt.length > MAX_PROMPT) throw new Error("提示词过长");
	if (request.cwd.trim().length === 0) throw new Error("必须指定项目目录");
	normalizeSchedule(request.schedule);
}

/** Human-readable schedule summary for list rows. */
export function describeSchedule(schedule: AutomationSchedule): string {
	switch (schedule.kind) {
		case "interval":
			return schedule.minutes % 60 === 0
				? `Every ${String(schedule.minutes / 60)}h`
				: `Every ${String(schedule.minutes)}m`;
		case "daily":
			return `Daily ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
		case "cron":
			return schedule.expression;
	}
}
