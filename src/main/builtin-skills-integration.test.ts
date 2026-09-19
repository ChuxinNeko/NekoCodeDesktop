import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuiltinSkillStore } from "./builtin-skills";
import { pi } from "./pi";
import type { PromptContext } from "./prompt-library";
import { createPromptResources } from "./workflow-runtime";

/**
 * The seam that decides whether a built-in skill exists at all: what the agent
 * core's resource loader ends up holding, and what it writes into the system
 * prompt. A skill the loader does not list is a skill the model is never told
 * about, however well the settings page renders it.
 *
 * Runs against the real `resources/skills`, so a shipped file with broken
 * frontmatter fails here rather than in front of a user.
 */

const CATALOG = join(import.meta.dir, "..", "..", "resources", "skills");

const temporary: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-skill-load-"));
	temporary.push(dir);
	return dir;
}

afterEach(() => {
	while (temporary.length) rmSync(temporary.pop() ?? "", { recursive: true, force: true });
});

const context = (): PromptContext => ({ mode: "agent", permission: "read-only", phase: "execute" });

async function load(store: BuiltinSkillStore) {
	const cwd = workspace();
	const agentDir = workspace();
	// An empty agent home, so nothing the developer running these tests happens
	// to have in ~/.nekocode can decide whether they pass.
	mkdirSync(join(agentDir, "skills"), { recursive: true });
	const loader = await createPromptResources(cwd, context, false, agentDir, store);
	return { loader, cwd };
}

describe("built-in skills reach the agent", () => {
	test("the shipped catalog is what the loader lists", async () => {
		const store = new BuiltinSkillStore(CATALOG, join(workspace(), "state.json"));
		const { loader } = await load(store);
		const names = loader.getSkills().skills.map((skill) => skill.name);
		expect(names).toContain("design");
		expect(names).toContain("clone-website");
		expect(names).toContain("code-review");
		expect(names).toContain("explore-codebase");
		expect(names).toContain("debug-root-cause");
		expect(names).toContain("write-tests");
		expect(names).toContain("refactor-safely");
		expect(loader.getSkills().diagnostics).toEqual([]);
	});

	test("a switched-off skill is not loaded at all", async () => {
		const store = new BuiltinSkillStore(CATALOG, join(workspace(), "state.json"));
		store.setEnabled("code-review", false);
		const { loader } = await load(store);
		const names = loader.getSkills().skills.map((skill) => skill.name);
		expect(names).not.toContain("code-review");
		// The rest are untouched — one switch moves one skill.
		expect(names).toContain("write-tests");
	});

	test("the loaded skills become the block the model reads paths out of", async () => {
		const { formatSkillsForPrompt } = await pi();
		const store = new BuiltinSkillStore(CATALOG, join(workspace(), "state.json"));
		const { loader } = await load(store);
		const block = formatSkillsForPrompt(loader.getSkills().skills);
		expect(block).toContain("<available_skills>");
		expect(block).toContain("<name>code-review</name>");
		// The path is the whole point: the body stays on disk and the model is
		// told where to open it.
		expect(block).toContain(join(CATALOG, "code-review", "SKILL.md"));
	});

	test("nothing is attached to a helper session, which runs without skills", async () => {
		const store = new BuiltinSkillStore(CATALOG, join(workspace(), "state.json"));
		const cwd = workspace();
		const agentDir = workspace();
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		const loader = await createPromptResources(cwd, context, true, agentDir, store);
		expect(loader.getSkills().skills).toEqual([]);
	});

	test("the clone skill defaults to a screenshot-free structured workflow", () => {
		const body = readFileSync(join(CATALOG, "clone-website", "SKILL.md"), "utf8");
		expect(body).toContain("## Screenshot-free default");
		expect(body).toContain("the default cloning workflow does not call it");
		expect(body).toContain("This structural comparison is the required QA path");
		expect(body).not.toContain(
			"Capture desktop at 1440×900, tablet at 768×900, and mobile at 390×844 with `browser_viewport` followed by `browser_screenshot`",
		);
	});

	test("an install with no catalog contributes nothing, and reports no errors", async () => {
		const store = new BuiltinSkillStore(null, join(workspace(), "state.json"));
		const { loader } = await load(store);
		// Not an empty list: the agent core also picks up the cross-tool
		// `~/.agents/skills` convention, which belongs to whoever is running this
		// and is none of the app's business. What must be absent is our own.
		const paths = loader.getSkills().skills.map((skill) => skill.filePath);
		expect(paths.some((path) => path.includes("resources"))).toBe(false);
		expect(loader.getSkills().diagnostics).toEqual([]);
	});
});
