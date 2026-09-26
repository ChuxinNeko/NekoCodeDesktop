import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
	readFrontmatterField,
	skillMarkdown,
	validateSkillDraft,
	type CreateSkillRequest,
	type ImportSkillsResult,
	type SkillImportCandidate,
	type SkillImportScan,
	type SkillSummary,
} from "../shared/skills";

/**
 * The skills a user keeps in the directories they own — `~/.nekocode/agent/skills`
 * and `<project>/.nekocode/skills` — as folders holding a `SKILL.md`.
 *
 * Everything here is plain file work on one of those directories. Which one, and
 * what to reload afterwards, is the agent service's business.
 */

/** Stop scanning an import source after this many folders; nobody means their whole disk. */
const SCAN_FOLDER_LIMIT = 2_000;
/** Deep enough for `repo/skills/<group>/<skill>`, shallow enough to stay quick. */
const SCAN_DEPTH_LIMIT = 5;
/** Never copied: the loader ignores them, and they can be enormous. */
const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** A name that is safe to use as one folder name on every platform we run on. */
function isSafeFolderName(name: string): boolean {
	return !!name && name !== "." && name !== ".." && !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !/[. ]$/.test(name);
}

/** Case-insensitive on Windows, where the file system is. */
function samePath(a: string, b: string): boolean {
	const normalize = (path: string) => {
		const resolved = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	return normalize(a) === normalize(b);
}

/** Whether `inner` is `outer` or somewhere below it. */
function isWithin(outer: string, inner: string): boolean {
	if (samePath(outer, inner)) return true;
	const rel = relative(resolve(outer), resolve(inner));
	return !!rel && !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel) && !rel.startsWith("/");
}

/**
 * The skill folders directly inside `dir`, read off disk.
 *
 * Only the `<name>/SKILL.md` shape: it is the one this page writes, and the one
 * a folder can be deleted for without taking something else with it.
 */
export function listInstalledSkills(dir: string | null, origin: "user" | "project"): SkillSummary[] {
	if (!dir) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const skills: SkillSummary[] = [];
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		const path = join(dir, entry, "SKILL.md");
		if (!isFile(path)) continue;
		let content = "";
		try {
			content = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		skills.push({
			name: readFrontmatterField(content, "name") || entry,
			description: readFrontmatterField(content, "description"),
			path,
			origin,
			enabled: true,
		});
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Write a hand-entered skill as `<dir>/<name>/SKILL.md`. Refuses to replace one. */
export function createSkill(dir: string, request: CreateSkillRequest): string {
	const problem = validateSkillDraft(request);
	if (problem) throw new Error(`技能内容无效：${problem}`);
	const name = request.name.trim();
	const folder = join(dir, name);
	if (existsSync(folder)) throw new Error(`已存在同名技能：${name}`);
	mkdirSync(folder, { recursive: true });
	const path = join(folder, "SKILL.md");
	writeFileSync(path, skillMarkdown({ ...request, name }), "utf8");
	return path;
}

/**
 * The skills a folder holds, by the loader's own rule: a folder with a SKILL.md
 * is one skill and is not looked into further; any other folder is searched.
 * So picking a single skill's folder, a `skills/` collection, or a repository
 * that keeps them somewhere inside all work.
 */
export function scanSkillSource(source: string, destination: string | null): SkillImportScan {
	if (!isDirectory(source)) throw new Error(`不是一个目录：${source}`);
	const found: Array<{ dir: string; content: string }> = [];
	let visited = 0;
	let truncated = false;

	const walk = (dir: string, depth: number) => {
		if (truncated) return;
		if (++visited > SCAN_FOLDER_LIMIT) {
			truncated = true;
			return;
		}
		const skillFile = join(dir, "SKILL.md");
		if (isFile(skillFile)) {
			try {
				found.push({ dir, content: readFileSync(skillFile, "utf8") });
			} catch {
				// Unreadable: nothing to show for it, and nothing that would load.
			}
			return;
		}
		if (depth >= SCAN_DEPTH_LIMIT) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries.sort()) {
			if (entry.startsWith(".") || SKIPPED_FOLDERS.has(entry)) continue;
			const child = join(dir, entry);
			if (isDirectory(child)) walk(child, depth + 1);
		}
	};
	walk(source, 0);

	const seen = new Set<string>();
	const candidates: SkillImportCandidate[] = found.map(({ dir, content }) => {
		const declared = readFrontmatterField(content, "name");
		// The folder is named after the skill once installed, so the declared
		// name wins when it can be a folder name at all.
		const name = isSafeFolderName(declared) ? declared : basename(dir);
		const description = readFrontmatterField(content, "description");
		const target = destination ? join(destination, name) : null;
		let problem: SkillImportCandidate["problem"] = null;
		if (!description) problem = "noDescription";
		else if (destination && (isWithin(dir, destination) || isWithin(destination, dir))) problem = "sameLocation";
		else if (seen.has(name)) problem = "duplicate";
		seen.add(name);
		return { name, description, dir, problem, exists: !!target && existsSync(target) };
	});
	return { source, candidates, truncated };
}

/**
 * Copy the chosen skills' folders into `destination` — the whole folder, since a
 * skill's references and scripts sit beside its SKILL.md and it points at them
 * by relative path.
 */
export function importSkillFolders(
	destination: string,
	candidates: SkillImportCandidate[],
	overwrite: boolean,
): Omit<ImportSkillsResult, "snapshot"> {
	const imported: string[] = [];
	const skipped: ImportSkillsResult["skipped"] = [];
	mkdirSync(destination, { recursive: true });
	for (const candidate of candidates) {
		if (candidate.problem) {
			skipped.push({ name: candidate.name, reason: candidate.problem });
			continue;
		}
		const target = join(destination, candidate.name);
		// Checked again rather than trusted from the scan: the scan may have been
		// for the other scope, and the disk may have changed since.
		if (!samePath(dirname(target), destination) || !isSafeFolderName(candidate.name)) {
			skipped.push({ name: candidate.name, reason: "failed", message: "invalid name" });
			continue;
		}
		if (existsSync(target)) {
			if (!overwrite) {
				skipped.push({ name: candidate.name, reason: "exists" });
				continue;
			}
			rmSync(target, { recursive: true, force: true });
		}
		try {
			cpSync(candidate.dir, target, {
				recursive: true,
				filter: (source) => !SKIPPED_FOLDERS.has(basename(source)),
			});
			imported.push(candidate.name);
		} catch (error) {
			skipped.push({
				name: candidate.name,
				reason: "failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { imported, skipped };
}

/**
 * The folder to delete for an installed skill's SKILL.md, or null when the path
 * is not one — anything outside the given directories, or nested deeper than a
 * skill folder, is refused rather than trusted.
 */
export function installedSkillFolder(path: string, directories: Array<string | null>): string | null {
	if (basename(path) !== "SKILL.md" || !isFile(path)) return null;
	const folder = dirname(path);
	return directories.some((dir) => dir && samePath(dirname(folder), dir)) ? folder : null;
}
