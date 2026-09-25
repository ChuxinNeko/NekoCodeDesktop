import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./memory-store";
import { createMemoryTool } from "./memory-tool";
import { checkoutRoot, projectRoot } from "./project-root";

const base = mkdtempSync(join(tmpdir(), "nekocode-memory-"));
const repo = join(base, "repo");
const worktree = join(base, "wt");
const other = join(base, "other");
mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
mkdirSync(join(repo, "packages", "app"), { recursive: true });
mkdirSync(worktree, { recursive: true });
mkdirSync(other, { recursive: true });
writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("projectRoot", () => {
	test("climbs to the repository and follows a worktree back to its main checkout", () => {
		expect(projectRoot(join(repo, "packages", "app"))).toBe(repo);
		expect(projectRoot(worktree)).toBe(repo);
		expect(checkoutRoot(worktree)).toBe(worktree);
	});

	test("a folder outside any repository is its own project", () => {
		expect(projectRoot(other)).toBe(other);
	});
});

describe("MemoryStore", () => {
	test("project memories follow the project, user memories go everywhere", () => {
		const store = new MemoryStore(join(base, "data-1"));
		store.save({ scope: "user", text: "用中文回复" }, "user");
		store.save({ scope: "project", cwd: join(repo, "packages", "app"), text: "use bun" }, "agent");
		expect(store.forProject(worktree).map((e) => e.text).sort()).toEqual(["use bun", "用中文回复"]);
		expect(store.forProject(other).map((e) => e.text)).toEqual(["用中文回复"]);
		expect(store.forProject(undefined).map((e) => e.text)).toEqual(["用中文回复"]);
	});

	test("saving the same text twice keeps one entry", () => {
		const store = new MemoryStore(join(base, "data-2"));
		const first = store.save({ scope: "user", text: "short answers" }, "agent");
		const second = store.save({ scope: "user", text: "  short answers " }, "agent");
		expect(second.id).toBe(first.id);
		expect(store.list()).toHaveLength(1);
	});

	test("edits keep identity; removal persists", () => {
		const dir = join(base, "data-3");
		const store = new MemoryStore(dir);
		const entry = store.save({ scope: "project", cwd: repo, text: "a" }, "user");
		const edited = store.save({ id: entry.id, scope: "project", text: "b" }, "user");
		expect(edited).toMatchObject({ id: entry.id, project: entry.project, text: "b", createdAt: entry.createdAt });
		expect(new MemoryStore(dir).list().map((e) => e.text)).toEqual(["b"]);
		expect(store.remove(entry.id)).toBe(true);
		expect(JSON.parse(readFileSync(join(dir, "memory.json"), "utf8")).entries).toEqual([]);
	});

	test("rejects empty text and project memories with no project", () => {
		const store = new MemoryStore(join(base, "data-4"));
		expect(() => store.save({ scope: "user", text: "  " }, "user")).toThrow();
		expect(() => store.save({ scope: "project", text: "x" }, "user")).toThrow();
	});

	test("the prompt section lists both scopes with short ids", () => {
		const store = new MemoryStore(join(base, "data-5"));
		expect(store.promptSection(repo)).toBe("");
		const entry = store.save({ scope: "user", text: "line one\nline two" }, "user");
		store.save({ scope: "project", cwd: repo, text: "tests beside source" }, "user");
		const section = store.promptSection(repo);
		expect(section).toContain("## 长期记忆");
		expect(section).toContain(`[${entry.id.slice(0, 8)}] line one line two`);
		expect(section).toContain("tests beside source");
		expect(store.promptSection(other)).not.toContain("tests beside source");
	});

	test("notifies listeners on every write", () => {
		const store = new MemoryStore(join(base, "data-6"));
		let calls = 0;
		const stop = store.onChange(() => calls++);
		const entry = store.save({ scope: "user", text: "x" }, "user");
		store.remove(entry.id);
		stop();
		store.save({ scope: "user", text: "y" }, "user");
		expect(calls).toBe(2);
	});
});

describe("memory tool", () => {
	test("saves, lists and deletes by short id", async () => {
		const store = new MemoryStore(join(base, "data-7"));
		const tool = createMemoryTool(repo, store);
		const run = (params: unknown) => tool.execute("id", params as never, undefined, undefined, undefined as never);
		const saved = await run({ action: "save", text: "prefer tabs" });
		const text = (saved.content[0] as { text: string }).text;
		const id = /\[([0-9a-f]{8})\]/.exec(text)?.[1];
		expect(id).toBeDefined();
		expect(store.forProject(repo)[0]).toMatchObject({ scope: "project", source: "agent", text: "prefer tabs" });
		const listed = await run({ action: "list" });
		expect((listed.content[0] as { text: string }).text).toContain("prefer tabs");
		await run({ action: "delete", id: `[${id}]` });
		expect(store.list()).toEqual([]);
		await expect(run({ action: "delete", id: "deadbeef" })).rejects.toThrow();
	});
});
