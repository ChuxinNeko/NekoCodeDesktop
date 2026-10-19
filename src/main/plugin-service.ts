import { readFileSync, writeFileSync } from "node:fs";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
	isPluginSource,
	type InstallPluginRequest,
	type LocalExtensionSummary,
	type PluginActionRequest,
	type PluginSummary,
	type PluginsSnapshot,
} from "../shared/plugins";
import { pi } from "./pi";
import { discoverNativePlugins, installNativePlugin, removeNativePlugin, NATIVE_PLUGIN_PREFIX } from "./native-plugin-manifest";
import { nativePluginStates } from "./native-plugin-runtime";

type LoadedExtension = LoadExtensionsResult["extensions"][number];

/**
 * Loaded from a file the user placed — an extensions directory, a settings
 * entry, a CLI path — rather than from an installed package. pi labels these
 * `local`, `auto` or `cli`; what they share is not coming from a package.
 */
function isLoose(extension: LoadedExtension): boolean {
	return extension.sourceInfo.origin !== "package";
}

/**
 * The enabled set, one per state file for the whole process.
 *
 * Every open session has a service of its own, and each used to read the file
 * once: a toggle in one left the others with the list they started with. Now
 * that the set decides what loads, every session has to see the same one.
 */
const enabledSets = new Map<string, Set<string>>();

export function enabledPlugins(statePath: string): Set<string> {
	let set = enabledSets.get(statePath);
	if (!set) {
		set = new Set(readEnabled(statePath));
		enabledSets.set(statePath, set);
	}
	return set;
}

function readEnabled(statePath: string): string[] {
	try {
		const raw: unknown = JSON.parse(readFileSync(statePath, "utf8"));
		const list = (raw as { enabled?: unknown }).enabled;
		return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Installing, enabling, and reporting pi packages.
 *
 * Two pieces of state, deliberately kept apart:
 *
 * - *Installed* is pi's, recorded in its own settings (`~/.nekocode/agent/settings.json`
 *   or the project's `.nekocode/settings.json`) and managed through its package
 *   manager, so a package installed here is the same one `pi install` would
 *   produce and the CLI keeps working on it.
 * - *Enabled* is ours, and means "this package may run". A disabled package
 *   is hidden from the session's resource loader before anything is resolved
 *   (see `withEnabledPackages`), so none of its code is imported — its tools,
 *   event hooks, commands, skills and prompts are all off. Loading it to list
 *   its tools first would already be running it, which is what disabling is
 *   for. Installing is not authorizing.
 */
export class PluginService {
	private readonly enabled: Set<string>;
	private busy = false;

	constructor(
		private readonly options: {
			/** Where the enabled set lives; pi never reads it. */
			statePath: string;
			/** Override for isolated installations and tests. */
			agentDir?: string;
			onChange: () => void;
		},
	) {
		this.enabled = enabledPlugins(options.statePath);
	}

	private writeEnabled(): void {
		try {
			writeFileSync(this.options.statePath, `${JSON.stringify({ enabled: [...this.enabled] })}\n`);
		} catch {
			// Best-effort: the choice still applies to this run.
		}
	}

	private async manager(cwd: string) {
		const { DefaultPackageManager, SettingsManager, getAgentDir } = await pi();
		const agentDir = this.options.agentDir ?? getAgentDir();
		return new DefaultPackageManager({
			cwd,
			agentDir,
			// The same directory for settings as for packages, or an override would
			// install into one place and read the package list from another.
			settingsManager: SettingsManager.create(cwd, agentDir),
		});
	}

	isEnabled(source: string): boolean {
		return this.enabled.has(source);
	}

	/**
	 * Tool names the model may call from plugins right now.
	 *
	 * Extensions pi discovered on its own — a loose file dropped in the
	 * extensions directory — are trusted: the user put it there by hand, and
	 * there is no package to toggle. Everything installed as a package has to be
	 * turned on; a disabled one is not loaded at all, and the check here only
	 * covers the moment between a toggle and the reload that follows it.
	 */
	enabledTools(extensions: LoadExtensionsResult | undefined): string[] {
		const names: string[] = [];
		for (const extension of extensions?.extensions ?? []) {
			if (extension.path === "<inline:nekocode-native>") continue;
			if (!isLoose(extension) && !this.enabled.has(extension.sourceInfo.source)) continue;
			names.push(...extension.tools.keys());
		}
		for (const plugin of nativePluginStates(extensions)) if (this.enabled.has(plugin.source)) names.push(...plugin.tools);
		return [...new Set(names)];
	}

	setEnabled(request: PluginActionRequest & { enabled: boolean }): void {
		if (request.enabled) this.enabled.add(request.source);
		else this.enabled.delete(request.source);
		this.writeEnabled();
		this.options.onChange();
	}

	async list(cwd: string | null, extensions: LoadExtensionsResult | undefined): Promise<PluginsSnapshot> {
		if (!cwd) return { plugins: [], local: [], errors: [], busy: this.busy, loaded: false };
		const manager = await this.manager(cwd);
		const configured = manager.listConfiguredPackages();

		// Group what actually loaded by the package it came from, so a row can
		// report the tools it contributes rather than just its source string.
		const tools = new Map<string, string[]>();
		const commands = new Map<string, string[]>();
		const failures = new Map<string, string[]>();
		const local: LocalExtensionSummary[] = [];
		for (const extension of extensions?.extensions ?? []) {
			if (extension.hidden) continue;
			if (isLoose(extension)) {
				local.push({
					path: extension.path,
					scope: extension.sourceInfo.scope === "project" ? "project" : "user",
					tools: [...extension.tools.keys()],
					commands: [...extension.commands.keys()],
				});
				continue;
			}
			const source = extension.sourceInfo.source;
			tools.set(source, [...(tools.get(source) ?? []), ...extension.tools.keys()]);
			commands.set(source, [...(commands.get(source) ?? []), ...extension.commands.keys()]);
		}
		const loose: string[] = [];
		for (const failure of extensions?.errors ?? []) {
			const owner = configured.find(
				(entry) => entry.installedPath && failure.path.startsWith(entry.installedPath),
			);
			if (!owner) {
				loose.push(`${failure.path}: ${failure.error}`);
				continue;
			}
			const bucket = failures.get(owner.source) ?? [];
			bucket.push(failure.error);
			failures.set(owner.source, bucket);
		}

		const plugins: PluginSummary[] = configured.map((entry) => ({
			source: entry.source,
			scope: entry.scope,
			...(entry.installedPath ? { installedPath: entry.installedPath } : {}),
			enabled: this.enabled.has(entry.source),
			tools: [...new Set(tools.get(entry.source) ?? [])],
			commands: [...new Set(commands.get(entry.source) ?? [])],
			...(failures.has(entry.source) ? { error: failures.get(entry.source)!.join("\n") } : {}),
		}));
		const agentDir = this.options.agentDir ?? (await pi()).getAgentDir();
		const nativeStates = nativePluginStates(extensions);
		for (const native of await discoverNativePlugins(cwd, agentDir)) {
			const state = nativeStates.find(state => state.source === native.source);
			const error = native.error ?? state?.error;
			plugins.push({ kind: "nekocode", source: native.source, scope: native.scope, installedPath: native.root,
				name: native.manifest?.name, version: native.manifest?.version, description: native.manifest?.description,
				enabled: this.enabled.has(native.source), tools: state?.tools ?? [], commands: state?.commands ?? [],
				...(error ? { error } : {}),
			});
		}
		return { plugins, local, errors: loose, busy: this.busy, loaded: extensions !== undefined };
	}

	async install(cwd: string, request: InstallPluginRequest): Promise<void> {
		if (!isPluginSource(request.source)) throw new Error("不是有效的插件来源");
		await this.run(cwd, async (manager) => {
			const agentDir = this.options.agentDir ?? (await pi()).getAgentDir();
			const native = await installNativePlugin(cwd, agentDir, request.source.trim(), request.scope);
			if (native) {
				this.enabled.delete(native.source);
				this.writeEnabled();
				return;
			}
			await manager.installAndPersist(request.source.trim(), { local: request.scope === "project" });
		});
	}

	async remove(cwd: string, request: PluginActionRequest): Promise<void> {
		await this.run(cwd, async (manager) => {
			if (request.source.startsWith(NATIVE_PLUGIN_PREFIX)) {
				await removeNativePlugin(cwd, this.options.agentDir ?? (await pi()).getAgentDir(), request.source);
				return;
			}
			await manager.removeAndPersist(request.source, { local: request.scope === "project" });
		});
		// Leaving it enabled would silently re-authorize a reinstall later.
		this.enabled.delete(request.source);
		this.writeEnabled();
	}

	async update(cwd: string, source?: string): Promise<void> {
		await this.run(cwd, async (manager) => {
			if (source?.startsWith(NATIVE_PLUGIN_PREFIX)) return; // The following session reload reimports it.
			await manager.update(source);
		});
	}

	/** One package operation at a time — npm and git do not share a directory well. */
	private async run(
		cwd: string,
		action: (manager: Awaited<ReturnType<PluginService["manager"]>>) => Promise<void>,
	): Promise<void> {
		if (this.busy) throw new Error("另一个插件操作正在进行中");
		this.busy = true;
		this.options.onChange();
		try {
			await action(await this.manager(cwd));
		} finally {
			this.busy = false;
			this.options.onChange();
		}
	}
}
