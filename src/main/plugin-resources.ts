import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageSource, SettingsManager } from "@earendil-works/pi-coding-agent";
import { pi } from "./pi";

/** What a session's resource loader is allowed to bring in from pi packages. */
export interface PluginResourcePolicy {
	/** Whether the installed package with this source may load at all. */
	isEnabled(source: string): boolean;
	/**
	 * Put the trust question for a project that would run plugin code of its
	 * own. Absent where nobody is there to answer — an automation — and then
	 * only a decision already saved counts.
	 */
	askTrust?(cwd: string): Promise<TrustChoice>;
}

/** "once" trusts the project until the app quits, without saving anything. */
export type TrustChoice = "always" | "once" | "never";

export function packageSource(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;

/**
 * Hide disabled packages from a loader's settings.
 *
 * The filter has to sit before the package manager resolves anything: pi's
 * `extensionsOverride` only runs after every extension has been imported, so a
 * disabled package would already have run its code by then. Hiding the entry
 * here means it is never resolved, never auto-installed and never imported —
 * while pi's settings files, which the CLI shares, keep it untouched. Only this
 * instance's reads are filtered; it never saves, and pi's own writes go through
 * its private state rather than these getters.
 */
export function withEnabledPackages(settings: SettingsManager, isEnabled: (source: string) => boolean): SettingsManager {
	const filter = (value: Settings): Settings =>
		value.packages ? { ...value, packages: value.packages.filter((pkg) => isEnabled(packageSource(pkg))) } : value;
	const global = settings.getGlobalSettings.bind(settings);
	const project = settings.getProjectSettings.bind(settings);
	settings.getGlobalSettings = () => filter(global());
	settings.getProjectSettings = () => filter(project());
	return settings;
}

/**
 * Does the project bring code that would run — packages its settings declare,
 * or an extensions directory?
 *
 * Narrower than pi's own test, which also asks before reading a project's
 * skills and prompts. Those are text the model reads, and the app has always
 * loaded them; asking about every project that has a skill would be a prompt on
 * nearly every folder opened, for no code run.
 */
export function projectRunsCode(configDir: string): boolean {
	if (existsSync(join(configDir, "extensions")) || existsSync(join(configDir, "plugins"))) return true;
	try {
		const raw = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as {
			packages?: unknown;
			extensions?: unknown;
		};
		const declares = (value: unknown) => Array.isArray(value) && value.length > 0;
		return declares(raw.packages) || declares(raw.extensions);
	} catch {
		return false;
	}
}

/** Projects trusted "once", for the life of the app. */
const trustedForNow = new Set<string>();

/**
 * Settle whether a project's own settings and plugins may load.
 *
 * Decisions are kept in pi's `trust.json`, so a project trusted in the CLI is
 * trusted here and the other way round. A project with nothing that runs is
 * trusted as before.
 */
export async function resolvePluginTrust(
	cwd: string,
	agentDir: string,
	ask?: (cwd: string) => Promise<TrustChoice>,
): Promise<boolean> {
	const { getProjectConfigDir, ProjectTrustStore } = await pi();
	if (!projectRunsCode(getProjectConfigDir(cwd))) return true;
	const store = new ProjectTrustStore(agentDir);
	const saved = store.get(cwd);
	if (saved !== null) return saved;
	if (trustedForNow.has(cwd)) return true;
	if (!ask) return false;
	const choice = await ask(cwd);
	if (choice === "always") store.set(cwd, true);
	else if (choice === "never") store.set(cwd, false);
	else trustedForNow.add(cwd);
	return choice !== "never";
}

/** Record trust the user gave by installing a package into the project themselves. */
export async function trustProject(cwd: string, agentDir: string): Promise<void> {
	const { ProjectTrustStore } = await pi();
	const store = new ProjectTrustStore(agentDir);
	if (store.get(cwd) !== true) store.set(cwd, true);
}
