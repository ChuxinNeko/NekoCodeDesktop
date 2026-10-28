import { app } from "electron";

import { SHARED_PROFILE_ENV } from "../shared/linux-run-mode";
export { SHARED_PROFILE_ENV, PROFILE_BRIDGE_ENV, PROFILE_TOKEN_ENV } from "../shared/linux-run-mode";

/** Browser storage stays private to each process; application data retains its original paths. */
export function appDataPath(): string {
	return process.platform === "linux" && process.getuid?.() === 0 && process.env.NEKOCODE_ROOT_SESSION
		? process.env[SHARED_PROFILE_ENV] || app.getPath("userData")
		: app.getPath("userData");
}
