import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openShellChanges, parsePatch, pathKey, ShellChangeTracker, WorkspaceSnapshots } from "../../../src/main/acp/workspace-changes";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "nk-shell-"));
	roots.push(root);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
	git("init", "-q");
	writeFileSync(join(root, "app.py"), "def greet(name):\n    return name\n\n\nprint(greet('x'))\n");
	writeFileSync(join(root, "old.txt"), "gone soon\n");
	writeFileSync(join(root, ".gitignore"), "build/\n");
	git("add", ".");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	return root;
}

describe("parsePatch", () => {
	test("reads a git patch file by file, in the edit card's line format", () => {
		const patch = [
			"diff --git a/src/a.ts b/src/a.ts",
			"index 1..2 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,3 +1,3 @@",
			" one",
			"-two",
			"+TWO",
			" three",
			"@@ -10,1 +10,2 @@",
			" ten",
			"+eleven",
			"\\ No newline at end of file",
			"diff --git a/新.txt b/新.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/新.txt",
			"@@ -0,0 +1,2 @@",
			"+hello\r",
			"+world",
			"diff --git a/img.png b/img.png",
			"Binary files a/img.png and b/img.png differ",
			"",
		].join("\n");
		const changes = parsePatch(patch, "/p");
		expect(changes).toEqual([
			{ path: resolve("/p", "src/a.ts"), kind: "update", diff: " 1 one\n-2 two\n+2 TWO\n 3 three\n ...\n 10 ten\n+11 eleven" },
			{ path: resolve("/p", "新.txt"), kind: "add", diff: "+1 hello\n+2 world", content: "hello\nworld" },
		]);
	});
});

describe("WorkspaceSnapshots", () => {
	test("sees what a command changed, without touching the user's index", async () => {
		const root = repo();
		const indexBefore = readFileSync(join(root, ".git", "index"));
		const snapshots = (await WorkspaceSnapshots.open(root))!;
		expect(snapshots).not.toBeNull();
		const before = await snapshots.snapshot();
		writeFileSync(join(root, "app.py"), "def say_hello(name):\n    return name\n\n\nprint(say_hello('x'))\n");
		writeFileSync(join(root, "new.txt"), "from shell\n");
		rmSync(join(root, "old.txt"));
		mkdirSync(join(root, "build"));
		writeFileSync(join(root, "build", "out.js"), "ignored\n");
		const after = await snapshots.snapshot();
		const changes = await snapshots.changes(before, after);
		expect(changes.map((change) => [change.path, change.kind])).toEqual([
			[join(root, "app.py"), "update"],
			[join(root, "new.txt"), "add"],
			[join(root, "old.txt"), "delete"],
		]);
		expect(changes[0].diff).toContain("-1 def greet(name):");
		expect(changes[0].diff).toContain("+1 def say_hello(name):");
		expect(changes[1].content).toBe("from shell");
		expect(changes[2].diff).toBe("-1 gone soon");
		expect(readFileSync(join(root, ".git", "index"))).toEqual(indexBefore);
		snapshots.dispose();
	});

	test("is not offered outside a git work tree", async () => {
		const plain = mkdtempSync(join(tmpdir(), "nk-plain-"));
		roots.push(plain);
		expect(await WorkspaceSnapshots.open(plain)).toBeNull();
	});
});

describe("ShellChangeTracker", () => {
	test("overlap detected while a diff is in flight invalidates its result", async () => {
		let finishDiff!: (changes: Array<{ path: string; kind: "add"; diff: string }>) => void;
		let startedDiff!: () => void;
		const started = new Promise<void>((resolve) => { startedDiff = resolve; });
		let sequence = 0;
		const a = new ShellChangeTracker({
			snapshot: async () => String(++sequence),
			changes: () => {
				startedDiff();
				return new Promise((resolve) => { finishDiff = resolve; });
			},
			dispose: () => {},
		}, "in-flight-worktree");
		const b = new ShellChangeTracker({ snapshot: async () => "base", changes: async () => [], dispose: () => {} }, "in-flight-worktree");
		try {
			await a.begin();
			const settling = a.settle();
			await started;
			await b.begin();
			finishDiff([{ path: "/other-session.txt", kind: "add", diff: "+1 other" }]);
			expect(await settling).toEqual([]);
		} finally {
			a.dispose();
			b.dispose();
		}
	});

	test("different directories inside one worktree share the attribution guard", async () => {
		const root = repo();
		const subdir = join(root, "nested");
		mkdirSync(subdir);
		const a = (await openShellChanges(root))!;
		const b = (await openShellChanges(subdir))!;
		try {
			await a.begin();
			await b.begin();
			writeFileSync(join(subdir, "other-session.txt"), "other\n");
			expect(await a.settle()).toEqual([]);
			expect(await b.settle()).toEqual([]);
		} finally {
			a.dispose();
			b.dispose();
		}
	});

	test("overlapping sessions in one worktree never claim each other's file changes", async () => {
		const root = repo();
		const a = (await openShellChanges(root))!;
		const b = (await openShellChanges(root))!;
		try {
			await a.begin();
			await b.begin();
			writeFileSync(join(root, "session-a.txt"), "A's output\n");
			writeFileSync(join(root, "session-b.txt"), "B's output\n");
			// Directory diffs cannot establish who wrote either file.
			expect(await a.settle()).toEqual([]);
			await a.end();
			// B's baseline still includes the overlap even after A finishes.
			expect(await b.settle()).toEqual([]);
			await b.end();
			await b.begin();
			writeFileSync(join(root, "session-b.txt"), "B's next turn\n");
			expect((await b.settle()).map((change) => change.path)).toEqual([join(root, "session-b.txt")]);
			await b.end();
		} finally {
			a.dispose();
			b.dispose();
		}
	});

	test("each command gets what changed since the last, minus files its edit tools showed", async () => {
		const root = repo();
		const tracker = (await openShellChanges(root))!;
		// Outside a turn, nothing is attributed.
		writeFileSync(join(root, "before.txt"), "user's own\n");
		expect(await tracker.settle()).toEqual([]);

		await tracker.begin();
		// The agent's edit tool changed app.py and said so; a command wrote new.txt.
		tracker.noteEdit("edit-1", [join(root, "app.py")], true);
		writeFileSync(join(root, "app.py"), "patched\n");
		writeFileSync(join(root, "new.txt"), "one\n");
		const first = await tracker.settle();
		expect(first.map((change) => change.path)).toEqual([join(root, "new.txt")]);

		// The next command only owns what happened after the first.
		writeFileSync(join(root, "new.txt"), "one\ntwo\n");
		writeFileSync(join(root, "app.py"), "patched\nby formatter\n");
		const second = await tracker.settle();
		expect(second.map((change) => [change.path, change.diff])).toEqual([
			[join(root, "app.py"), " 1 patched\n+2 by formatter"],
			[join(root, "new.txt"), " 1 one\n+2 two"],
		]);
		expect(await tracker.settle()).toEqual([]);

		await tracker.end();
		writeFileSync(join(root, "later.txt"), "x\n");
		expect(await tracker.settle()).toEqual([]);
		tracker.dispose();
	});

	test("compares paths the way the file system does", () => {
		expect(pathKey("C:\\Repo\\A.ts", "win32")).toBe(pathKey("c:/repo/a.ts", "win32"));
	});
});
