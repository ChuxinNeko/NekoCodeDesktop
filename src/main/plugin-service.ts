import { readFileSync, writeFileSync } from "node:fs";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
	isPluginSource,
	type InstallPluginRequest,
	type PluginActionRequest,
	type PluginSummary,
	type PluginsSnapshot,
} from "../shared/plugins";
import { pi } from "./pi";

/** Extensions loaded from a location pi discovers on its own, not from a package. */
const LOOSE_SOURCE = "";

/**
 * Installing, enabling, and reporting pi packages.
 *
 * Two pieces of state, deliberately kept apart:
 *
 * - *Installed* is pi's, recorded in its own settings (`~/.nekocode/agent/settings.json`
 *   or the project's `.nekocode/settings.json`) and managed through its package
 *   manager, so a package installed here is the same one `pi install` would
 *   produce and the CLI keeps working on it.
 * - *Enabled* is ours, and means "the model may call this package's tools".
 *   A package's extensions load either way — refusing to load them is how you
 *   lose the list of what they registered, which is exactly what the user needs
 *   to decide. Installing is not authorizing.
 */
export class PluginService {
	private enabled: Set<string>;
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
		this.enabled = new Set(this.readEnabled());
	}

	private readEnabled(): string[] {
		try {
			const raw: unknown = JSON.parse(readFileSync(this.options.statePath, "utf8"));
			const list = (raw as { enabled?: unknown }).enabled;
			return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
		} catch {
			return [];
		}
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
		return new DefaultPackageManager({
			cwd,
			agentDir: this.options.agentDir ?? getAgentDir(),
			settingsManager: SettingsManager.create(cwd),
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
	 * turned on.
	 */
	enabledTools(extensions: LoadExtensionsResult | undefined): string[] {
		const names: string[] = [];
		for (const extension of extensions?.extensions ?? []) {
			const source = extension.sourceInfo.source || LOOSE_SOURCE;
			if (source !== LOOSE_SOURCE && !this.enabled.has(source)) continue;
			names.push(...extension.tools.keys());
		}
		return [...new Set(names)];
	}

	setEnabled(request: PluginActionRequest & { enabled: boolean }): void {
		if (request.enabled) this.enabled.add(request.source);
		else this.enabled.delete(request.source);
		this.writeEnabled();
		this.options.onChange();
	}

	async list(cwd: string | null, extensions: LoadExtensionsResult | undefined): Promise<PluginsSnapshot> {
		if (!cwd) return { plugins: [], errors: [], busy: this.busy };
		const manager = await this.manager(cwd);
		const configured = manager.listConfiguredPackages();

		// Group what actually loaded by the package it came from, so a row can
		// report the tools it contributes rather than just its source string.
		const tools = new Map<string, string[]>();
		const failures = new Map<string, string[]>();
		for (const extension of extensions?.extensions ?? []) {
			const source = extension.sourceInfo.source || LOOSE_SOURCE;
			const bucket = tools.get(source) ?? [];
			bucket.push(...extension.tools.keys());
			tools.set(source, bucket);
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
			...(failures.has(entry.source) ? { error: failures.get(entry.source)!.join("\n") } : {}),
		}));
		return { plugins, errors: loose, busy: this.busy };
	}

	async install(cwd: string, request: InstallPluginRequest): Promise<void> {
		if (!isPluginSource(request.source)) throw new Error("不是有效的插件来源");
		await this.run(cwd, async (manager) => {
			await manager.installAndPersist(request.source.trim(), { local: request.scope === "project" });
		});
	}

	async remove(cwd: string, request: PluginActionRequest): Promise<void> {
		await this.run(cwd, async (manager) => {
			await manager.removeAndPersist(request.source, { local: request.scope === "project" });
		});
		// Leaving it enabled would silently re-authorize a reinstall later.
		this.enabled.delete(request.source);
		this.writeEnabled();
	}

	async update(cwd: string, source?: string): Promise<void> {
		await this.run(cwd, async (manager) => {
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
