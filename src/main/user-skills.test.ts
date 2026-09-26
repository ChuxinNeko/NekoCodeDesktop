import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFrontmatterField, skillMarkdown, splitSkillMarkdown, validateSkillDraft } from "../shared/skills";
import {
	createSkill,
	importSkillFolders,
	installedSkillFolder,
	listInstalledSkills,
	scanSkillSource,
} from "./user-skills";

const base = mkdtempSync(join(tmpdir(), "nekocode-skills-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function writeSkill(dir: string, frontmatter: string, body = "Body.\n"): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
}

describe("validateSkillDraft", () => {
	test("holds names to the loader's rule", () => {
		expect(validateSkillDraft({ name: "", description: "x" })).toBe("nameRequired");
		expect(validateSkillDraft({ name: "My Skill", description: "x" })).toBe("nameInvalid");
		expect(validateSkillDraft({ name: "a--b", description: "x" })).toBe("nameInvalid");
		expect(validateSkillDraft({ name: "-a", description: "x" })).toBe("nameInvalid");
		expect(validateSkillDraft({ name: "a".repeat(65), description: "x" })).toBe("nameTooLong");
		expect(validateSkillDraft({ name: "review-pr", description: " " })).toBe("descriptionRequired");
		expect(validateSkillDraft({ name: "review-pr", description: "Review a PR" })).toBeNull();
	});
});

describe("skillMarkdown", () => {
	test("round-trips a description with YAML-significant characters", () => {
		const content = skillMarkdown({ name: "x", description: 'Use when: "quoted" #1\nsecond line', body: "# Steps\r\n" });
		expect(readFrontmatterField(content, "name")).toBe("x");
		expect(readFrontmatterField(content, "description")).toBe('Use when: "quoted" #1 second line');
		expect(content.endsWith("\n# Steps\n")).toBe(true);
	});

	test("a pasted SKILL.md splits into the editor's fields", () => {
		expect(splitSkillMarkdown("---\r\nname: a\r\ndescription: >\r\n  folded\r\n  text\r\n---\r\n\r\n# Body\r\n")).toEqual({
			name: "a",
			description: "folded text",
			body: "# Body\n",
		});
		expect(splitSkillMarkdown("# just markdown")).toBeNull();
	});
});

describe("createSkill and listInstalledSkills", () => {
	const dir = join(base, "user-skills");

	test("writes a folder the listing reads back, and refuses a second of the same name", () => {
		const path = createSkill(dir, { scope: "user", name: "deploy", description: "Ship it", body: "Steps" });
		expect(path).toBe(join(dir, "deploy", "SKILL.md"));
		expect(listInstalledSkills(dir, "user")).toEqual([
			{ name: "deploy", description: "Ship it", path, origin: "user", enabled: true },
		]);
		expect(() => createSkill(dir, { scope: "user", name: "deploy", description: "Again", body: "" })).toThrow();
	});

	test("a missing directory is an empty list", () => {
		expect(listInstalledSkills(join(base, "nope"), "project")).toEqual([]);
		expect(listInstalledSkills(null, "project")).toEqual([]);
	});
});

describe("scanSkillSource and importSkillFolders", () => {
	const source = join(base, "source");
	const destination = join(base, "dest");
	writeSkill(join(source, "alpha"), "name: alpha\ndescription: First");
	writeFileSync(join(source, "alpha", "reference.md"), "ref");
	mkdirSync(join(source, "alpha", "node_modules", "junk"), { recursive: true });
	writeSkill(join(source, "group", "beta-folder"), "name: beta\ndescription: Second");
	writeSkill(join(source, "group", "nodesc"), "name: nodesc");
	writeSkill(join(source, "other", "alpha"), "description: Same name");
	// A skill root is not searched further, as the loader does not either.
	writeSkill(join(source, "alpha", "nested"), "name: nested\ndescription: Hidden");
	writeSkill(join(destination, "beta"), "name: beta\ndescription: Old");

	test("finds skills at any depth and flags what cannot be imported", () => {
		const scan = scanSkillSource(source, destination);
		const byDir = Object.fromEntries(scan.candidates.map((entry) => [entry.dir, entry]));
		expect(scan.candidates.map((entry) => entry.name).sort()).toEqual(["alpha", "alpha", "beta", "nodesc"]);
		expect(byDir[join(source, "alpha")]).toMatchObject({ problem: null, exists: false });
		expect(byDir[join(source, "group", "beta-folder")]).toMatchObject({ name: "beta", problem: null, exists: true });
		expect(byDir[join(source, "group", "nodesc")]?.problem).toBe("noDescription");
		expect(byDir[join(source, "other", "alpha")]?.problem).toBe("duplicate");
	});

	test("copies whole folders, skips installed ones unless told to replace them", () => {
		const scan = scanSkillSource(source, destination);
		const result = importSkillFolders(destination, scan.candidates, false);
		expect(result.imported).toEqual(["alpha"]);
		expect(result.skipped.map((entry) => entry.reason).sort()).toEqual(["duplicate", "exists", "noDescription"]);
		expect(readFileSync(join(destination, "alpha", "reference.md"), "utf8")).toBe("ref");
		expect(existsSync(join(destination, "alpha", "node_modules"))).toBe(false);

		const replaced = importSkillFolders(
			destination,
			scan.candidates.filter((entry) => entry.name === "beta"),
			true,
		);
		expect(replaced.imported).toEqual(["beta"]);
		expect(readFrontmatterField(readFileSync(join(destination, "beta", "SKILL.md"), "utf8"), "description")).toBe("Second");
	});

	test("the destination itself is not a source", () => {
		const scan = scanSkillSource(destination, destination);
		expect(scan.candidates.every((entry) => entry.problem === "sameLocation")).toBe(true);
	});
});

describe("installedSkillFolder", () => {
	const user = join(base, "owned");
	writeSkill(join(user, "mine"), "name: mine\ndescription: Mine");
	writeSkill(join(user, "mine", "deeper"), "name: deeper\ndescription: Deeper");
	writeSkill(join(base, "elsewhere", "theirs"), "name: theirs\ndescription: Theirs");

	test("only a direct skill folder of an owned directory can be deleted", () => {
		expect(installedSkillFolder(join(user, "mine", "SKILL.md"), [user, null])).toBe(join(user, "mine"));
		expect(installedSkillFolder(join(user, "mine", "deeper", "SKILL.md"), [user, null])).toBeNull();
		expect(installedSkillFolder(join(base, "elsewhere", "theirs", "SKILL.md"), [user, null])).toBeNull();
		expect(installedSkillFolder(join(user, "SKILL.md"), [user])).toBeNull();
	});
});
