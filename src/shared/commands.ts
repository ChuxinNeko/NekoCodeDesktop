/**
 * Slash commands as the composer offers them.
 *
 * These are not a new mechanism: `AgentSession.prompt` already expands a
 * leading `/skill:<name>` into the skill's body and a leading `/<template>`
 * into its prompt file. Both only expand when the slash is the first character
 * of the message, which is why the composer holds an accepted command as a
 * separate pill rather than as text the user can bury mid-sentence.
 */

export type SlashCommandKind =
	/** A SKILL.md the session loaded; invoked as `/skill:<name>`. */
	| "skill"
	/** A markdown prompt template from `prompts/`; invoked as `/<name>`. */
	| "prompt"
	/** One of the app's own commands, like `/init`; handled in main before the core sees it. */
	| "builtin";

export interface SlashCommandSummary {
	/** What follows the slash — `skill:design` or `review`. Unique per list. */
	name: string;
	/** The one line explaining what it does, shown beside the name. */
	description: string;
	kind: SlashCommandKind;
	/**
	 * What the template expects after the name, e.g. `<file> [--fix]`. Only
	 * prompt templates declare one; skills take free-form text.
	 */
	argumentHint?: string;
}
