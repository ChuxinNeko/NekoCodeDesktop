import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUILTIN_SKILL_NAMES,
	BuiltinSkillStore,
	readBuiltinSkills,
	readFrontmatterField,
	resolveBuiltinSkillsDir,
} from "./builtin-skills";

const temporary: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-skills-"));
	temporary.push(dir);
	return dir;
}

function skill(dir: string, name: string, frontmatter: string, body = "步骤一。"): string {
	mkdirSync(join(dir, name), { recursive: true });
	const path = join(dir, name, "SKILL.md");
	writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
	return path;
}

afterEach(() => {
	while (temporary.length) rmSync(temporary.pop() ?? "", { recursive: true, force: true });
});

describe("readFrontmatterField", () => {
	test("reads a bare scalar", () => {
		expect(readFrontmatterField("---\nname: code-review\n---\nbody", "name")).toBe("code-review");
	});

	test("strips the quotes a YAML author may have added", () => {
		expect(readFrontmatterField(`---\ndescription: "审查代码: 找缺陷"\n---\n`, "description")).toBe(
			"审查代码: 找缺陷",
		);
		expect(readFrontmatterField("---\ndescription: '单引号'\n---\n", "description")).toBe("单引号");
	});

	test("joins a folded block into the one line the settings row shows", () => {
		const content = "---\nname: a\ndescription: >-\n  第一行\n  第二行\nother: x\n---\n";
		expect(readFrontmatterField(content, "description")).toBe("第一行 第二行");
	});

	test("a missing field, or no frontmatter at all, is empty rather than a guess", () => {
		expect(readFrontmatterField("---\nname: a\n---\n", "description")).toBe("");
		expect(readFrontmatterField("# 没有 frontmatter\n", "description")).toBe("");
		expect(readFrontmatterField("---\nname: a\nno closing fence", "name")).toBe("");
	});

	test("tolerates CRLF, which is what an editor on Windows writes", () => {
		expect(readFrontmatterField("---\r\nname: code-review\r\n---\r\nbody", "name")).toBe("code-review");
	});
});

describe("readBuiltinSkills", () => {
	test("names a skill by its directory and lists it in catalog order", () => {
		const dir = workspace();
		skill(dir, "write-tests", "name: write-tests\ndescription: 补测试");
		skill(dir, "explore-codebase", "name: explore-codebase\ndescription: 摸清代码库");
		const skills = readBuiltinSkills(dir);
		// The catalog opens with explore-codebase, whatever order the filesystem
		// happened to hand the directories back in.
		expect(skills.map((entry) => entry.name)).toEqual(["explore-codebase", "write-tests"]);
		expect(skills[0].description).toBe("摸清代码库");
		expect(skills[1].path).toBe(join(dir, "write-tests", "SKILL.md"));
	});

	test("a directory without a SKILL.md is not a skill", () => {
		const dir = workspace();
		mkdirSync(join(dir, "notes"), { recursive: true });
		writeFileSync(join(dir, "notes", "README.md"), "# 不是技能", "utf8");
		skill(dir, "code-review", "name: code-review\ndescription: 审查");
		expect(readBuiltinSkills(dir).map((entry) => entry.name)).toEqual(["code-review"]);
	});

	test("a missing directory reports nothing rather than throwing", () => {
		expect(readBuiltinSkills(join(workspace(), "not-here"))).toEqual([]);
	});

	test("skills outside the catalog still load, after the ones in it", () => {
		const dir = workspace();
		skill(dir, "zzz-custom", "name: zzz-custom\ndescription: 额外");
		skill(dir, "code-review", "name: code-review\ndescription: 审查");
		expect(readBuiltinSkills(dir).map((entry) => entry.name)).toEqual(["code-review", "zzz-custom"]);
	});
});

describe("resolveBuiltinSkillsDir", () => {
	test("prefers the packaged resources directory, then the checkout", () => {
		const packaged = workspace();
		mkdirSync(join(packaged, "skills"), { recursive: true });
		const checkout = workspace();
		mkdirSync(join(checkout, "resources", "skills"), { recursive: true });

		expect(resolveBuiltinSkillsDir({ appPath: checkout, resourcesPath: packaged })).toBe(
			join(packaged, "skills"),
		);
		expect(resolveBuiltinSkillsDir({ appPath: checkout })).toBe(join(checkout, "resources", "skills"));
	});

	test("an override wins, and nothing found is null rather than a bad path", () => {
		const dir = workspace();
		expect(resolveBuiltinSkillsDir({ appPath: workspace(), override: dir })).toBe(dir);
		expect(resolveBuiltinSkillsDir({ appPath: join(workspace(), "nope") })).toBeNull();
	});
});

describe("BuiltinSkillStore", () => {
	const setup = () => {
		const dir = workspace();
		skill(dir, "code-review", "name: code-review\ndescription: 审查代码");
		skill(dir, "write-tests", "name: write-tests\ndescription: 补测试");
		return { dir, statePath: join(workspace(), "state", "builtin-skills.json") };
	};

	test("everything ships enabled", () => {
		const { dir, statePath } = setup();
		const store = new BuiltinSkillStore(dir, statePath);
		expect(store.list().every((entry) => entry.enabled)).toBe(true);
		expect(store.list().map((entry) => entry.origin)).toEqual(["code-review", "write-tests"].map(() => "builtin"));
	});

	test("switching one off survives a restart", () => {
		const { dir, statePath } = setup();
		new BuiltinSkillStore(dir, statePath).setEnabled("write-tests", false);

		const reopened = new BuiltinSkillStore(dir, statePath);
		const byName = new Map(reopened.list().map((entry) => [entry.name, entry.enabled]));
		expect(byName.get("write-tests")).toBe(false);
		expect(byName.get("code-review")).toBe(true);
	});

	test("only the off ones are written, so a later version's skills arrive enabled", () => {
		const { dir, statePath } = setup();
		const store = new BuiltinSkillStore(dir, statePath);
		store.setEnabled("code-review", false);
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ disabled: ["code-review"] });

		// A skill that did not exist when the file was written.
		skill(dir, "refactor-safely", "name: refactor-safely\ndescription: 重构");
		const reopened = new BuiltinSkillStore(dir, statePath);
		expect(reopened.list().find((entry) => entry.name === "refactor-safely")?.enabled).toBe(true);
	});

	test("switching back on removes it again", () => {
		const { dir, statePath } = setup();
		const store = new BuiltinSkillStore(dir, statePath);
		store.setEnabled("code-review", false);
		store.setEnabled("code-review", true);
		expect(store.list().every((entry) => entry.enabled)).toBe(true);
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ disabled: [] });
	});

	test("hands the loader every built-in path, on or off", () => {
		const { dir, statePath } = setup();
		const store = new BuiltinSkillStore(dir, statePath);
		store.setEnabled("write-tests", false);
		// The paths are fixed when the session's loader is built; the filter below
		// is what a toggle actually moves, so both files stay on the list.
		expect(store.paths()).toHaveLength(2);
	});

	test("the filter drops disabled built-ins and lets everything else through", () => {
		const { dir, statePath } = setup();
		const store = new BuiltinSkillStore(dir, statePath);
		store.setEnabled("write-tests", false);

		expect(store.isEnabled(join(dir, "write-tests", "SKILL.md"))).toBe(false);
		expect(store.isEnabled(join(dir, "code-review", "SKILL.md"))).toBe(true);
		// A user's own skill, even one that shares a name with a disabled built-in.
		expect(store.isEnabled("/home/me/.nekocode/agent/skills/write-tests/SKILL.md")).toBe(true);
	});

	test("an install with no built-in skills is empty, not broken", () => {
		const store = new BuiltinSkillStore(null, join(workspace(), "state.json"));
		expect(store.list()).toEqual([]);
		expect(store.paths()).toEqual([]);
		expect(store.isEnabled("/anywhere/SKILL.md")).toBe(true);
	});

	test("a corrupt state file falls back to everything enabled", () => {
		const { dir } = setup();
		const statePath = join(workspace(), "builtin-skills.json");
		writeFileSync(statePath, "{ not json", "utf8");
		expect(new BuiltinSkillStore(dir, statePath).list().every((entry) => entry.enabled)).toBe(true);
	});
});

describe("the shipped catalog", () => {
	test("every name in the catalog is a directory with a valid SKILL.md", () => {
		const dir = join(import.meta.dir, "..", "..", "resources", "skills");
		const skills = readBuiltinSkills(dir);
		expect(skills.map((entry) => entry.name)).toEqual([...BUILTIN_SKILL_NAMES]);
		for (const entry of skills) {
			// The agent core drops a skill with no description and warns when the
			// frontmatter name does not match its directory.
			expect(entry.description.length).toBeGreaterThan(10);
			expect(readFrontmatterField(readFileSync(entry.path, "utf8"), "name")).toBe(entry.name);
			expect(entry.name).toMatch(/^[a-z0-9-]+$/);
		}
	});
});
