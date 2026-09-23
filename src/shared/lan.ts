export interface LanDevice { id: string; name: string; pairedAt: number }
export interface LanProject { id: string; name: string; path: string }
export interface LanStatus {
	enabled: boolean;
	urls: string[];
	pairing: { code: string; expiresAt: number } | null;
	devices: LanDevice[];
	projects: LanProject[];
}
import type { AgentDefaults, ExecutionMode, SessionSummary, ThinkingLevel } from "./agent";
import type { FastContextConfig } from "./fast-context";
import type { FusionConfig } from "./fusion";
import type { WorkMode } from "./workflow";

export interface LanTaskOptions {
	modelKey?: string;
	thinkingLevel?: ThinkingLevel;
	mode?: ExecutionMode;
	workMode?: WorkMode;
	fusion?: FusionConfig;
	fastContext?: FastContextConfig;
}
export interface LanState {
	tasks: Array<Omit<SessionSummary, "sessionFile">>;
	projects: LanProject[];
}
export type LanDefaults = AgentDefaults;
