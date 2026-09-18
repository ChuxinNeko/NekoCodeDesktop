/**
 * PI packages, as this app manages them.
 *
 * A "plugin" here is a pi package — the same thing `pi install` handles — which
 * may bundle extensions, skills, prompt templates, or themes. The name follows
 * the settings page rather than pi's vocabulary because that is what a user
 * looking for this feature will search for.
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
	/** The install source, which is also its identity: `npm:@foo/bar`, `git:…`. */
	source: string;
	scope: PluginScope;
	/** Absent when the source is configured but not yet installed on disk. */
	installedPath?: string;
	/**
	 * Whether this package's tools may be called.
	 *
	 * Separate from installed: a package's extensions load and register their
	 * tools either way, because refusing to load them is how you lose the very
	 * list the user needs to decide. Enabling is what lets the model call them.
	 */
	enabled: boolean;
	/** Tool names its extensions registered, once loaded. Empty until then. */
	tools: string[];
	/** Load failure, reported rather than swallowed. */
	error?: string;
}

export interface PluginsSnapshot {
	plugins: PluginSummary[];
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
	if (!source || source.length > 500 || /\s/.test(source)) return false;
	return (
		source.startsWith("npm:") ||
		source.startsWith("git:") ||
		source.startsWith("http://") ||
		source.startsWith("https://") ||
		source.startsWith(".") ||
		source.startsWith("/") ||
		/^[a-zA-Z]:[\\/]/.test(source)
	);
}
