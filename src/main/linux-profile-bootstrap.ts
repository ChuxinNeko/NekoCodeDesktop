import { app } from "electron";
import { existsSync, mkdtempSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE_BRIDGE_ENV, PROFILE_TOKEN_ENV, SHARED_PROFILE_ENV } from "./linux-profile-paths";
import { profileRequestSync, type ProfileHandoff } from "./linux-profile-bridge";
import { repairChangedProfileEntry, repairProfileOwnership } from "./linux-profile-owner";

export let rootProfileHandoff: ProfileHandoff | undefined;
export let repairRootProfile = () => {};

// Imported before crash diagnostics or any store reads the user's paths.
if (process.platform === "linux" && process.getuid?.() === 0 && process.env.NEKOCODE_ROOT_SESSION) {
	const profile = process.env[SHARED_PROFILE_ENV];
	const bridge = process.env[PROFILE_BRIDGE_ENV];
	const token = process.env[PROFILE_TOKEN_ENV];
	const home = process.env.HOME;
	const uid = Number(process.env.PKEXEC_UID);
	if (!profile || !bridge || !token || !home || !Number.isInteger(uid) || uid <= 0) throw new Error("A root session requires the original user's profile bridge");
	const profileInfo = statSync(profile);
	if (profileInfo.uid !== uid || statSync(home).uid !== uid || realpathSync(profile) !== profile || realpathSync(home) !== home) {
		throw new Error("The shared profile must belong to the desktop user");
	}
	// Stop original writers after authorization succeeds, before opening their stores.
	rootProfileHandoff = profileRequestSync(bridge, token, "prepare") as ProfileHandoff;
	const runtime = mkdtempSync(join(tmpdir(), "nekocode-root-runtime-"));
	app.setPath("userData", runtime);
	app.setPath("sessionData", runtime);
	app.setPath("home", home);
	const roots = [profile, join(home, ".nekocode"), join(home, ".codex"), join(home, ".claude")];
	repairRootProfile = () => {
		for (const path of [...roots, join(home, ".claude.json")]) {
			repairProfileOwnership(path, uid, profileInfo.gid);
		}
	};
	const watchers = new Map<string, FSWatcher>();
	const dirty = new Map<string, Set<string>>();
	const timer = setInterval(() => {
		for (const root of roots) {
			if (!watchers.has(root) && existsSync(root)) {
				try {
					const watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => {
						if (name) { const paths = dirty.get(root) ?? new Set<string>(); paths.add(String(name)); dirty.set(root, paths); }
					});
					watcher.on("error", () => { watcher.close(); watchers.delete(root); });
					watchers.set(root, watcher);
				} catch { /* The final sweep still restores ownership if the OS watch limit is reached. */ }
			}
		}
		for (const [root, paths] of dirty) {
			for (const relative of paths) {
				try { repairChangedProfileEntry(root, relative, uid, profileInfo.gid); } catch { /* Repaired by the final sweep if a store is mid-rename. */ }
			}
		}
		dirty.clear();
	}, 1000);
	timer.unref();
	process.on("uncaughtExceptionMonitor", repairRootProfile);
	process.on("exit", repairRootProfile);
	app.on("will-quit", () => { clearInterval(timer); for (const watcher of watchers.values()) watcher.close(); repairRootProfile(); });
}
