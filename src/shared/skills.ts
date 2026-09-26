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
	/**
	 * Skill folders in the user's and the open project's skills directories,
	 * read straight off disk — so a skill added here shows up before any session
	 * has loaded it. These are the ones the page can delete.
	 */
	installed: SkillSummary[];
	/** Directories a user can drop their own skills into, for the hint text. */
	directories: { user: string; project: string | null };
	/** Problems the loader reported: bad frontmatter, name collisions. */
	warnings: string[];
}

export interface SetSkillEnabledRequest {
	name: string;
	enabled: boolean;
}

/** Where a skill written from the settings page goes — the two directories a user owns. */
export type SkillScope = "user" | "project";

/** The limits the agent core checks names and descriptions against. */
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export interface CreateSkillRequest {
	scope: SkillScope;
	name: string;
	description: string;
	/** The Markdown below the frontmatter: what the model reads when it opens the skill. */
	body: string;
}

export type SkillDraftProblem =
	| "nameRequired"
	| "nameInvalid"
	| "nameTooLong"
	| "descriptionRequired"
	| "descriptionTooLong";

/**
 * What stops a hand-written skill from being saved, or null when nothing does.
 *
 * Stricter than the loader, which loads a badly named skill with a warning:
 * this one is about to be written, so there is no reason to write it wrong.
 */
export function validateSkillDraft(draft: { name: string; description: string }): SkillDraftProblem | null {
	const name = draft.name.trim();
	if (!name) return "nameRequired";
	if (name.length > SKILL_NAME_MAX_LENGTH) return "nameTooLong";
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return "nameInvalid";
	const description = draft.description.trim();
	if (!description) return "descriptionRequired";
	if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) return "descriptionTooLong";
	return null;
}

/** Why a skill found in an import source cannot be copied as it is. */
export type SkillImportProblem =
	/** No description: the loader would skip it, so importing it would do nothing. */
	| "noDescription"
	/** Another skill in the same source claims this name. */
	| "duplicate"
	/** The source already is — or contains, or sits inside — the destination. */
	| "sameLocation";

export interface SkillImportCandidate {
	/** The name it will be installed under: frontmatter `name`, else its folder. */
	name: string;
	description: string;
	/** The folder holding its SKILL.md — the thing that gets copied. */
	dir: string;
	problem: SkillImportProblem | null;
	/** A skill of this name is already installed in the chosen scope. */
	exists: boolean;
}

export interface ScanSkillImportRequest {
	source: string;
	scope: SkillScope;
}

export interface SkillImportScan {
	source: string;
	candidates: SkillImportCandidate[];
	/** The scan stopped early: the folder is too big to have been meant. */
	truncated: boolean;
}

export interface ImportSkillsRequest {
	source: string;
	scope: SkillScope;
	/** Which of the scan's candidates to copy, by `dir`. */
	dirs: string[];
	/** Replace an installed skill of the same name instead of skipping it. */
	overwrite: boolean;
}

export interface ImportSkillsResult {
	snapshot: SkillsSnapshot;
	imported: string[];
	skipped: Array<{ name: string; reason: SkillImportProblem | "exists" | "failed"; message?: string }>;
}

export interface RemoveSkillRequest {
	/** The SKILL.md of an installed skill; its whole folder goes. */
	path: string;
}

/**
 * The first line of a skill's YAML frontmatter that matters here.
 *
 * Deliberately not a YAML parser: the loader in the agent core already validates
 * these files properly, and all this needs is the one line the settings page
 * shows. It handles the shapes the skills are usually written in — a quoted or
 * bare scalar, and the folded/literal block forms — and returns empty for
 * anything else rather than guessing.
 */
export function readFrontmatterField(content: string, field: string): string {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---\n")) return "";
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return "";
	const lines = normalized.slice(4, end).split("\n");

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (!line.startsWith(`${field}:`)) continue;
		const inline = line.slice(field.length + 1).trim();
		if (inline && inline !== ">" && inline !== "|" && inline !== ">-" && inline !== "|-") {
			return unquote(inline);
		}
		// Block scalar: every following line indented deeper than the key.
		const block: string[] = [];
		for (let next = index + 1; next < lines.length; next++) {
			const candidate = lines[next] ?? "";
			if (candidate.trim() && !/^\s/.test(candidate)) break;
			block.push(candidate.trim());
		}
		return block.join(" ").trim();
	}
	return "";
}

function unquote(value: string): string {
	const quote = value[0];
	if (quote === '"' && value.endsWith(quote) && value.length >= 2) {
		// Double-quoted YAML escapes the way JSON does, near enough for one line.
		try {
			return JSON.parse(value) as string;
		} catch {
			return value.slice(1, -1);
		}
	}
	if (quote === "'" && value.endsWith(quote) && value.length >= 2) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * A whole SKILL.md taken apart into the fields the editor has, for when one is
 * pasted in rather than typed. Null when the text has no frontmatter.
 */
export function splitSkillMarkdown(content: string): { name: string; description: string; body: string } | null {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---\n")) return null;
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return null;
	const afterFence = normalized.indexOf("\n", end + 4);
	return {
		name: readFrontmatterField(normalized, "name"),
		description: readFrontmatterField(normalized, "description"),
		body: afterFence === -1 ? "" : normalized.slice(afterFence + 1).replace(/^\n+/, ""),
	};
}

/** The file the loader reads: frontmatter the core can parse, then the body. */
export function skillMarkdown(request: Pick<CreateSkillRequest, "name" | "description" | "body">): string {
	// JSON's string syntax is a valid YAML double-quoted scalar, which keeps a
	// description with a colon or a quote in it from breaking the frontmatter.
	const description = JSON.stringify(request.description.replace(/\s*\n\s*/g, " ").trim());
	const body = request.body.replace(/\r\n?/g, "\n").trim();
	return `---\nname: ${request.name.trim()}\ndescription: ${description}\n---\n\n${body ? `${body}\n` : ""}`;
}
