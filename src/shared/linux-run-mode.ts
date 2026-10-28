export type LinuxRunMode = "current" | "root";

export interface LinuxRunModeStatus {
	platform: string;
	mode: LinuxRunMode;
	user: string;
	canElevate: boolean;
	canReturn: boolean;
	unavailableReason?: "development" | "pkexec" | "display";
}

export function isLinuxRunMode(value: unknown): value is LinuxRunMode {
	return value === "current" || value === "root";
}
