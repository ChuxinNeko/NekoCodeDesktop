import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the agent core kept its home before this app rebranded the kernel. */
const LEGACY_DIR_NAME = ".pi";
const DIR_NAME = ".nekocode";

export type AgentHomeMigration = "migrated" | "already-present" | "nothing-to-migrate";

/**
 * Carry the agent home over from the kernel's original location.
 *
 * Renaming the config directory would otherwise orphan everything already in
 * it — sessions, settings, and the OAuth tokens the core stores in auth.json —
 * with no sign to the user beyond an app that forgot who they were.
 *
 * It copies rather than moves: the original directory may still belong to a
 * separately installed pi CLI, and taking its home away is not this app's call.
 * The copy lands under a temporary name and is renamed into place, so a run
 * interrupted halfway leaves nothing behind that would make the next run think
 * the migration had already happened.
 */
export function migrateAgentHome(home: string = homedir()): AgentHomeMigration {
	const target = join(home, DIR_NAME, "agent");
	if (existsSync(target)) return "already-present";
	const legacy = join(home, LEGACY_DIR_NAME, "agent");
	if (!existsSync(legacy)) return "nothing-to-migrate";

	const parent = join(home, DIR_NAME);
	const staging = join(parent, `agent.migrating-${process.pid}`);
	mkdirSync(parent, { recursive: true });
	try {
		rmSync(staging, { recursive: true, force: true });
		cpSync(legacy, staging, { recursive: true });
		renameSync(staging, target);
	} catch (error) {
		try {
			rmSync(staging, { recursive: true, force: true });
		} catch {
			// best-effort cleanup of our own staging directory
		}
		throw error;
	}
	return "migrated";
}
