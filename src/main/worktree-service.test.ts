import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeService } from "./worktree-service";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repository with one commit on `main`, which is what `prepare` needs. */
function makeRepo(root: string): string {
	const repo = join(root, "project");
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-b", "main");
	// Identity is per-repo so the test never depends on the machine's git config.
	git(repo, "config", "user.email", "test@nekocode.local");
	git(repo, "config", "user.name", "NekoCode Test");
	writeFileSync(join(repo, "README.md"), "base\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "initial");
	return repo;
}

describe("background task isolation", () => {
	let root: string;
	let repo: string;
	let service: WorktreeService;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "nekocode-worktree-"));
		repo = makeRepo(root);
		service = new WorktreeService(join(root, "userData"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("a prepared task gets its own directory and branch off the current one", async () => {
		const prepared = await service.prepare(repo);

		expect(prepared.worktree).not.toBeNull();
		expect(prepared.warning).toBeUndefined();
		expect(prepared.cwd).toBe(prepared.worktree!.path);
		expect(prepared.cwd).not.toBe(repo);
		expect(prepared.worktree!.base).toBe("main");
		expect(prepared.worktree!.branch).toStartWith("nekocode/task-");
		// The fork point is real: the base commit's file is already there.
		expect(existsSync(join(prepared.cwd, "README.md"))).toBe(true);
	});

	test("edits in a task's worktree are invisible to the main checkout", async () => {
		const prepared = await service.prepare(repo);
		service.attach("task-1", "/sessions/task-1.jsonl", prepared.worktree);

		writeFileSync(join(prepared.cwd, "README.md"), "changed by the task\n");
		writeFileSync(join(prepared.cwd, "new-file.ts"), "export const x = 1;\n");

		// This is the whole point: a second task working in `repo` sees none of it.
		expect(git(repo, "status", "--porcelain").trim()).toBe("");
		const status = await service.status("task-1");
		expect(status).not.toBeNull();
		expect(status!.missing).toBe(false);
		expect(status!.dirtyFiles).toBe(2);
		expect(status!.ahead).toBe(0);
	});

	test("merging commits the task's work and brings it back to the base branch", async () => {
		const prepared = await service.prepare(repo);
		service.attach("task-1", "/sessions/task-1.jsonl", prepared.worktree);
		writeFileSync(join(prepared.cwd, "new-file.ts"), "export const x = 1;\n");

		const result = await service.merge({ sessionId: "task-1", message: "整理一下 README" });

		expect(result).toEqual({ merged: true, commits: 1 });
		expect(existsSync(join(repo, "new-file.ts"))).toBe(true);
		expect(git(repo, "log", "-1", "--format=%s").trim()).toContain("nekocode/task-");
		// Merged means done with: the checkout, the branch and the record all go.
		expect(existsSync(prepared.cwd)).toBe(false);
		expect(service.forSession("task-1")).toBeNull();
		expect(git(repo, "branch", "--list", prepared.worktree!.branch).trim()).toBe("");
	});

	test("merging refuses, without touching the repo, when the base branch moved on", async () => {
		const prepared = await service.prepare(repo);
		service.attach("task-1", "/sessions/task-1.jsonl", prepared.worktree);
		writeFileSync(join(prepared.cwd, "new-file.ts"), "export const x = 1;\n");
		git(repo, "checkout", "-q", "-b", "other");

		const result = await service.merge({ sessionId: "task-1", message: "x" });

		expect(result.merged).toBe(false);
		if (result.merged) return;
		expect(result.reason).toContain("other");
		expect(result.reason).toContain("main");
		// Refused before anything happened: the work is still on its branch.
		expect(existsSync(join(repo, "new-file.ts"))).toBe(false);
		expect(service.forSession("task-1")).not.toBeNull();
		expect(existsSync(prepared.cwd)).toBe(true);
	});

	test("merging refuses when the main checkout has uncommitted work of its own", async () => {
		const prepared = await service.prepare(repo);
		service.attach("task-1", "/sessions/task-1.jsonl", prepared.worktree);
		writeFileSync(join(prepared.cwd, "new-file.ts"), "export const x = 1;\n");
		writeFileSync(join(repo, "README.md"), "the user is mid-edit\n");

		const result = await service.merge({ sessionId: "task-1", message: "x" });

		expect(result.merged).toBe(false);
		expect(git(repo, "status", "--porcelain")).toContain("README.md");
		expect(existsSync(join(repo, "new-file.ts"))).toBe(false);
	});

	test("discarding removes the checkout, the branch and the record", async () => {
		const prepared = await service.prepare(repo);
		service.attach("task-1", "/sessions/task-1.jsonl", prepared.worktree);
		writeFileSync(join(prepared.cwd, "new-file.ts"), "export const x = 1;\n");

		await service.discard("task-1");

		expect(existsSync(prepared.cwd)).toBe(false);
		expect(service.forSession("task-1")).toBeNull();
		expect(git(repo, "branch", "--list", prepared.worktree!.branch).trim()).toBe("");
		expect(existsSync(join(repo, "new-file.ts"))).toBe(false);
	});

	test("deleting a session releases the checkout it was working in", async () => {
		const prepared = await service.prepare(repo);
		service.attach("task-1", "/sessions/task-1.jsonl", prepared.worktree);

		await service.releaseByFile("/sessions/task-1.jsonl");

		expect(existsSync(prepared.cwd)).toBe(false);
		expect(service.list()).toHaveLength(0);
	});

	test("a project that is not a repository runs in place, silently", async () => {
		const plain = join(root, "plain");
		mkdirSync(plain, { recursive: true });

		const prepared = await service.prepare(plain);

		expect(prepared).toEqual({ cwd: plain, worktree: null });
	});

	test("a repository with no commits says why it could not isolate", async () => {
		const empty = join(root, "empty");
		mkdirSync(empty, { recursive: true });
		git(empty, "init", "-b", "main");

		const prepared = await service.prepare(empty);

		expect(prepared.cwd).toBe(empty);
		expect(prepared.worktree).toBeNull();
		expect(prepared.warning).toContain("提交");
	});

	test("records survive a restart, so a crashed run's checkout stays reachable", async () => {
		const prepared = await service.prepare(repo);
		service.attach("task-1", "/sessions/task-1.jsonl", prepared.worktree);

		const reopened = new WorktreeService(join(root, "userData"));

		expect(reopened.forSession("task-1")?.path).toBe(prepared.cwd);
	});
});
