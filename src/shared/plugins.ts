/**
 * Plugins managed by NekoCode: native versioned plugin folders and compatible
 * PI packages that may bundle extensions, skills, prompts or themes.
 */

/** Where a package is recorded, and therefore who it applies to. */
export type PluginScope = "user" | "project";

export const PLUGIN_CATALOG_URL = "https://pi.dev/packages";
export const PLUGIN_TYPES = ["extension", "skill", "prompt", "theme"] as const;
export type PluginType = (typeof PLUGIN_TYPES)[number];
export type PluginCatalogSort = "downloads" | "recent" | "name";

export interface PluginCatalogQuery {
	search?: string;
	type?: PluginType | "";
	sort?: PluginCatalogSort;
	page?: number;
	refresh?: boolean;
}

export interface PluginCatalogEntry {
	name: string;
	description: string;
	author: string;
	types: PluginType[];
	downloads: number;
	updatedAt: number;
	url: string;
}

export interface PluginCatalogPage {
	packages: PluginCatalogEntry[];
	page: number;
	pages: number;
}

/** npm sources may pin versions, including scoped names such as @owner/pkg@1.0. */
export function pluginPackageName(source: string): string | null {
	if (!source.startsWith("npm:")) return null;
	const name = source.slice(4).trim();
	const version = name.indexOf("@", 1);
	return version < 0 ? name : name.slice(0, version);
}

export interface PluginSummary {
	/** Omitted means a legacy PI package. */
	kind?: "nekocode";
	name?: string;
	version?: string;
	description?: string;
	/** Opaque identity: npm/git source for PI, scope and installation path for native plugins. */
	source: string;
	scope: PluginScope;
	/** Absent when the source is configured but not yet installed on disk. */
	installedPath?: string;
	/**
	 * Whether this package may run.
	 *
	 * Separate from installed: an installed package that is not enabled is never
	 * loaded — none of its code runs, so its tools, hooks, commands, skills and
	 * prompts are all off. Enabling is what authorizes it.
	 */
	enabled: boolean;
	/** Tool names its extensions registered. Empty until it is enabled and loaded. */
	tools: string[];
	/** Slash commands its extensions registered, without the slash. */
	commands: string[];
	/** Load failure, reported rather than swallowed. */
	error?: string;
}

/**
 * An extension file the user placed by hand — in `~/.nekocode/agent/extensions/`
 * or the project's `.nekocode/extensions/` — rather than installed as a package.
 * There is no package to toggle, so these always load.
 */
export interface LocalExtensionSummary {
	path: string;
	scope: PluginScope;
	tools: string[];
	commands: string[];
}

export interface PluginsSnapshot {
	plugins: PluginSummary[];
	local: LocalExtensionSummary[];
	/**
	 * A session's extensions are loaded, so `tools` and `commands` are known.
	 * Without one open — the welcome screen — nothing has run to register them.
	 */
	loaded: boolean;
	/**
	 * Extension load errors that belong to no configured package — a stray file
	 * in `~/.nekocode/agent/extensions/` that threw.
	 */
	errors: string[];
	/** True while an install, removal, or update is in flight. */
	busy: boolean;
}

export interface InstallPluginRequest {
	/** `npm:@scope/pkg@1.2.3`, `git:github.com/user/repo@ref`, a URL, or a path. */
	source: string;
	/** Write to the project's `.nekocode/settings.json` instead of the user's. */
	scope: PluginScope;
}

export interface PluginActionRequest {
	source: string;
	scope: PluginScope;
}

export interface SetPluginEnabledRequest extends PluginActionRequest {
	enabled: boolean;
}

/**
 * Reject obvious nonsense before handing a source to pi's installer.
 *
 * Not a security boundary — pi resolves the source itself and a package runs
 * with full system access once installed. This only catches typos early, so a
 * blank field does not surface as an npm error three seconds later.
 */
export function isPluginSource(value: string): boolean {
	const source = value.trim();
	if (!source || source.length > 500 || /[\r\n\0]/.test(source)) return false;
	if (source.startsWith(".") || source.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(source)) return true;
	if (/\s/.test(source)) return false;
	return (
		source.startsWith("npm:") ||
		source.startsWith("git:") ||
		source.startsWith("http://") ||
		source.startsWith("https://")
	);
}
