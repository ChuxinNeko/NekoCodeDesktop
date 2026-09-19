/**
 * Skills as the settings page sees them.
 *
 * A skill is a `SKILL.md` whose name and description the agent core puts in the
 * system prompt; the body stays on disk and the model reads it only when the
 * task matches. That is why this carries the path — it is the thing the model is
 * told to open, and the thing a user has to find to edit.
 */

/** Where a skill came from, which decides whether it can be switched off here. */
export type SkillOrigin =
	/** Ships with the app. The only kind this settings page owns. */
	| "builtin"
	/** `~/.nekocode/agent/skills` — the user's own, across every project. */
	| "user"
	/** `<project>/.nekocode/skills` — checked in, shared with collaborators. */
	| "project"
	/** Installed as a package, or pulled in by an extension. */
	| "package";

export interface SkillSummary {
	/** Directory name, and what `/skill:<name>` takes. */
	name: string;
	/** The one line the model matches a task against. */
	description: string;
	/** Absolute path of the SKILL.md. */
	path: string;
	origin: SkillOrigin;
	/** Built-in skills can be switched off; the rest are enabled by existing. */
	enabled: boolean;
}

export interface SkillsSnapshot {
	/** Shipped with the app, in catalog order. Always present. */
	builtin: SkillSummary[];
	/**
	 * What the open session actually loaded, built-ins included. Empty when no
	 * session is open — discovery needs a working directory.
	 */
	active: SkillSummary[];
	/** Directories a user can drop their own skills into, for the hint text. */
	directories: { user: string; project: string | null };
	/** Problems the loader reported: bad frontmatter, name collisions. */
	warnings: string[];
}

export interface SetSkillEnabledRequest {
	name: string;
	enabled: boolean;
}
