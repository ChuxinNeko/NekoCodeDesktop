import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFrontmatterField, type SkillSummary } from "../shared/skills";

/**
 * The skills that ship with the app.
 *
 * They are plain `SKILL.md` files on disk rather than strings compiled into the
 * bundle, because the agent core does not hand a skill's body to the model — it
 * puts the *path* in the system prompt and lets the model read the file when the
 * task matches. A skill with no readable path is a skill the model cannot open.
 *
 * Which is also why they stay where they are installed instead of being copied
 * into the user's own skills directory: a copy would go stale the moment the app
 * updated, and it would sit in a directory the user is meant to own.
 */

/** Order the settings page lists them in — the catalog, not the directory. */
export const BUILTIN_SKILL_NAMES = [
	"design",
	"clone-website",
	"explore-codebase",
	"code-review",
	"debug-root-cause",
	"write-tests",
	"refactor-safely",
] as const;

export interface BuiltinSkillFile {
	name: string;
	description: string;
	path: string;
}

/**
 * Read the catalog off disk.
 *
 * Driven by the directory rather than by {@link BUILTIN_SKILL_NAMES}, so a skill
 * added to `resources/skills` shows up without a second edit here; the constant
 * only decides the order they are listed in.
 */
export function readBuiltinSkills(dir: string): BuiltinSkillFile[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// No directory means no built-in skills — a degraded install, not a crash.
		return [];
	}
	const order = new Map(BUILTIN_SKILL_NAMES.map((name, index) => [name as string, index]));
	const skills: BuiltinSkillFile[] = [];
	for (const entry of entries) {
		const path = join(dir, entry, "SKILL.md");
		try {
			if (!statSync(path).isFile()) continue;
		} catch {
			continue;
		}
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		skills.push({
			// The directory names the skill; frontmatter `name` has to match it,
			// and the agent core warns when it does not.
			name: entry,
			description: readFrontmatterField(content, "description"),
			path,
		});
	}
	return skills.sort(
		(a, b) =>
			(order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER) ||
			a.name.localeCompare(b.name),
	);
}

/**
 * Where the built-in skills live, across the ways this app gets run.
 *
 * Packaged, they are an extra resource beside the asar; from a checkout they are
 * `resources/skills` in the repository. Both are checked because a build that
 * has not been packaged yet is the normal case during development.
 */
export function resolveBuiltinSkillsDir(options: {
	appPath: string;
	resourcesPath?: string;
	override?: string;
}): string | null {
	const candidates = [
		options.override,
		options.resourcesPath ? join(options.resourcesPath, "skills") : undefined,
		join(options.appPath, "resources", "skills"),
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			if (statSync(candidate).isDirectory()) return candidate;
		} catch {
			// not this one
		}
	}
	return null;
}

interface StoredState {
	disabled?: unknown;
}

/**
 * Which built-in skills are switched on, and where their files are.
 *
 * Only the *off* ones are persisted, so a skill added in a later version arrives
 * enabled rather than silently missing from everyone's existing settings file.
 */
export class BuiltinSkillStore {
	private disabled = new Set<string>();

	constructor(
		/** The catalog directory; null when the install has no built-in skills. */
		private dir: string | null,
		/** Where the on/off state is kept. */
		private statePath: string,
	) {
		this.load();
	}

	private load(): void {
		try {
			const raw: StoredState = JSON.parse(readFileSync(this.statePath, "utf8"));
			if (Array.isArray(raw.disabled)) {
				this.disabled = new Set(raw.disabled.filter((name): name is string => typeof name === "string"));
			}
		} catch {
			// Missing or corrupt: everything stays on, which is the default anyway.
		}
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.statePath), { recursive: true });
			writeFileSync(this.statePath, JSON.stringify({ disabled: [...this.disabled] }, null, 2), "utf8");
		} catch (error) {
			// A preference that cannot be written is worth saying out loud: the
			// toggle would otherwise appear to work and forget itself on restart.
			console.error("Could not save the skill settings:", error);
		}
	}

	list(): SkillSummary[] {
		return (this.dir ? readBuiltinSkills(this.dir) : []).map((skill) => ({
			name: skill.name,
			description: skill.description,
			path: skill.path,
			origin: "builtin" as const,
			enabled: !this.disabled.has(skill.name),
		}));
	}

	/** Every built-in SKILL.md, on or off — what the loader is handed. */
	paths(): string[] {
		return (this.dir ? readBuiltinSkills(this.dir) : [])
			.map((skill) => skill.path)
			.filter((path) => existsSync(path));
	}

	/**
	 * The skill this path belongs to, or null when it is not one of ours.
	 *
	 * Paths are the only handle the resource loader's filter has, and a user is
	 * free to name their own skill after a built-in — so membership is decided by
	 * where the file sits, never by its name.
	 */
	private nameOf(filePath: string): string | null {
		if (!this.dir) return null;
		const prefix = `${this.dir.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
		const normalized = filePath.replace(/\\/g, "/");
		if (!normalized.startsWith(prefix)) return null;
		return normalized.slice(prefix.length).split("/")[0] || null;
	}

	isBuiltin(filePath: string): boolean {
		return this.nameOf(filePath) !== null;
	}

	/** Whether a loaded skill survives. Anything that is not a built-in does. */
	isEnabled(filePath: string): boolean {
		const name = this.nameOf(filePath);
		return name === null || !this.disabled.has(name);
	}

	setEnabled(name: string, enabled: boolean): void {
		if (enabled) this.disabled.delete(name);
		else this.disabled.add(name);
		this.save();
	}
}
