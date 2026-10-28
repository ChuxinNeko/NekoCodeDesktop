export type LinuxRunMode = "current" | "root";
export const SHARED_PROFILE_ENV = "NEKOCODE_SHARED_PROFILE";
export const PROFILE_BRIDGE_ENV = "NEKOCODE_PROFILE_BRIDGE";
export const PROFILE_TOKEN_ENV = "NEKOCODE_PROFILE_TOKEN";

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
