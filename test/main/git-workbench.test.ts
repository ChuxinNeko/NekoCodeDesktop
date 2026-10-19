import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAction, getDiff, getStatus, listScopeFiles } from "../../src/main/git";
import {
	abortMerge,
	assertRevision,
	branchAction,
	commitWorkbench,
	discardChanges,
	getCommitDetail,
	getCompareInfo,
	getLog,
	getRangeDiff,
	getRangeFiles,
	isAuthFailure,
	listBranches,
	remoteAction,
	revertCommit,
	undoLastCommit,
} from "../../src/main/git-workbench";

const root = mkdtempSync(join(tmpdir(), "nekocode-gitwb-"));
const env = {
	...process.env,
	GIT_AUTHOR_NAME: "Neko",
	GIT_AUTHOR_EMAIL: "neko@example.com",
	GIT_COMMITTER_NAME: "Neko",
	GIT_COMMITTER_EMAIL: "neko@example.com",
	GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
	GIT_CONFIG_NOSYSTEM: "1",
};
Object.assign(process.env, {
	GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME,
	GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL,
	GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME,
	GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL,
	GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL,
	GIT_CONFIG_NOSYSTEM: "1",
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
const write = (cwd: string, path: string, text: string) => {
	mkdirSync(join(cwd, path, ".."), { recursive: true });
	writeFileSync(join(cwd, path), text);
};
let n = 0;
const fresh = () => {
	const dir = join(root, `repo${String(n++)}`);
	mkdirSync(dir);
	sh(dir, "init", "-q", "-b", "main");
	return dir;
};

afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeAll(() => writeFileSync(join(root, "gitconfig"), ""));

describe("status", () => {
	test("a fresh repository has no HEAD but still lists, counts and diffs files", async () => {
		const dir = fresh();
		write(dir, "a.txt", "one\ntwo\n");
		sh(dir, "add", "a.txt");
		write(dir, "b.txt", "untracked\n");
		const status = await getStatus(dir);
		expect(status.hasCommits).toBe(false);
		expect(status.branch).toBe("main");
		expect(status.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
		expect(status.files[0]?.additions).toBe(2);
		expect(await getDiff({ cwd: dir, scope: "head", file: "a.txt" })).toContain("+two");
		expect(await getDiff({ cwd: dir, scope: "head", file: "b.txt" })).toContain("+untracked");
	});

	test("lists untracked files one by one, reports renames, and tolerates odd names", async () => {
		const dir = fresh();
		write(dir, "old name.txt", "keep\nkeep\nkeep\n");
		write(dir, "a[1].ts", "x\n");
		sh(dir, "add", "-A");
		sh(dir, "commit", "-qm", "init");
		sh(dir, "mv", "old name.txt", "new name.txt");
		write(dir, "deep/er/file.txt", "n\n");
		write(dir, "a[1].ts", "x\ny\n");
		const status = await getStatus(dir);
		const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));
		expect(byPath["new name.txt"]?.oldPath).toBe("old name.txt");
		expect(byPath["deep/er/file.txt"]?.untracked).toBe(true);
		expect(byPath["a[1].ts"]?.additions).toBe(1);
		// Literal pathspec: the brackets are the name, not a glob.
		expect(await getDiff({ cwd: dir, scope: "head", file: "a[1].ts" })).toContain("+y");
		const rename = await getDiff({ cwd: dir, scope: "head", file: "new name.txt", oldPath: "old name.txt" });
		expect(rename).toContain("rename from old name.txt");
	});

	test("tracks upstream, ahead/behind and the last commit", async () => {
		const origin = join(root, "origin-a.git");
		mkdirSync(origin);
		sh(origin, "init", "-q", "--bare", "-b", "main");
		const dir = fresh();
		sh(dir, "remote", "add", "origin", origin);
		write(dir, "a.txt", "1\n");
		sh(dir, "add", "-A");
		sh(dir, "commit", "-qm", "first");
		let status = await getStatus(dir);
		expect(status.upstream).toBeNull();
		expect(status.remote).toBe("origin");
		expect(status.lastCommit?.pushed).toBe(false);
		await remoteAction({ cwd: dir, action: "push" });
		status = await getStatus(dir);
		expect(status.upstream).toBe("origin/main");
		expect(status.ahead).toBe(0);
		expect(status.lastCommit?.pushed).toBe(true);
		write(dir, "b.txt", "2\n");
		await commitWorkbench({ cwd: dir, summary: "second" });
		status = await getStatus(dir);
		expect(status.ahead).toBe(1);
		const log = await getLog({ cwd: dir });
		expect(log.commits.map((c) => [c.subject, c.unpushed])).toEqual([["second", true], ["first", false]]);
	});

	test("works from a subfolder of the repository", async () => {
		const dir = fresh();
		write(dir, "sub/a.txt", "1\n");
		sh(dir, "add", "-A");
		sh(dir, "commit", "-qm", "init");
		write(dir, "sub/a.txt", "1\n2\n");
		write(dir, "top.txt", "t\n");
		const sub = join(dir, "sub");
		const status = await getStatus(sub);
		expect(status.files.map((f) => f.path).sort()).toEqual(["sub/a.txt", "top.txt"]);
		expect(await getDiff({ cwd: sub, scope: "head", file: "top.txt" })).toContain("+t");
		await applyAction({ cwd: sub, action: "stage", file: "sub/a.txt" });
		expect((await getStatus(sub)).files.find((f) => f.path === "sub/a.txt")?.staged).toBe(true);
		expect(await listScopeFiles(sub, "head")).toContain("top.txt");
	});
});

describe("commit", () => {
	test("commits only the ticked files and leaves the rest as working changes", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		write(dir, "b.txt", "b\n");
		sh(dir, "add", "-A");
		sh(dir, "commit", "-qm", "base");
		write(dir, "a.txt", "a2\n");
		write(dir, "b.txt", "b2\n");
		write(dir, "c.txt", "new\n");
		sh(dir, "add", "b.txt"); // staged earlier, but not ticked now
		const result = await commitWorkbench({ cwd: dir, summary: "only a and c", description: "details here", files: ["a.txt", "c.txt"] });
		expect(result.shortHash).toHaveLength(7);
		const show = sh(dir, "show", "--stat", "--format=%s%n%b", "HEAD");
		expect(show).toContain("only a and c");
		expect(show).toContain("details here");
		expect(show).toContain("a.txt");
		expect(show).toContain("c.txt");
		expect(show).not.toContain("b.txt");
		const status = await getStatus(dir);
		expect(status.files.map((f) => f.path)).toEqual(["b.txt"]);
	});

	test("commits every change when no selection is given, including deletions and the first commit", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		await commitWorkbench({ cwd: dir, summary: "root" });
		expect((await getStatus(dir)).hasCommits).toBe(true);
		rmSync(join(dir, "a.txt"));
		write(dir, "z.txt", "z\n");
		await commitWorkbench({ cwd: dir, summary: "swap" });
		expect(sh(dir, "ls-files").trim()).toBe("z.txt");
		expect((await getStatus(dir)).files).toEqual([]);
	});

	test("explains why it refuses", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		await expect(commitWorkbench({ cwd: dir, summary: "   " })).rejects.toThrow(/summary/i);
		await commitWorkbench({ cwd: dir, summary: "x" });
		await expect(commitWorkbench({ cwd: dir, summary: "nothing" })).rejects.toThrow(/nothing to commit/i);
		write(dir, "b.txt", "b\n");
		await expect(commitWorkbench({ cwd: dir, summary: "empty selection", files: [] })).rejects.toThrow(/at least one file/i);
	});

	test("amend rewrites the latest message", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		await commitWorkbench({ cwd: dir, summary: "typo" });
		write(dir, "b.txt", "b\n");
		await commitWorkbench({ cwd: dir, summary: "fixed", amend: true });
		const log = await getLog({ cwd: dir });
		expect(log.commits.map((c) => c.subject)).toEqual(["fixed"]);
		expect(sh(dir, "ls-files").trim().split("\n")).toEqual(["a.txt", "b.txt"]);
	});

	test("undo restores the message, keeps the changes, and refuses once pushed", async () => {
		const origin = join(root, "origin-b.git");
		mkdirSync(origin);
		sh(origin, "init", "-q", "--bare", "-b", "main");
		const dir = fresh();
		sh(dir, "remote", "add", "origin", origin);
		write(dir, "a.txt", "a\n");
		await commitWorkbench({ cwd: dir, summary: "root" });
		write(dir, "b.txt", "b\n");
		await commitWorkbench({ cwd: dir, summary: "to undo", description: "body text" });
		const undone = await undoLastCommit(dir);
		expect(undone).toEqual({ summary: "to undo", description: "body text" });
		expect((await getStatus(dir)).files.map((f) => f.path)).toEqual(["b.txt"]);
		// Root commit can be undone too.
		await commitWorkbench({ cwd: dir, summary: "again" });
		await remoteAction({ cwd: dir, action: "push" });
		await expect(undoLastCommit(dir)).rejects.toThrow(/already been pushed/);
		const solo = fresh();
		write(solo, "a.txt", "a\n");
		await commitWorkbench({ cwd: solo, summary: "only" });
		await undoLastCommit(solo);
		expect((await getStatus(solo)).hasCommits).toBe(false);
		expect((await getStatus(solo)).files.map((f) => f.path)).toEqual(["a.txt"]);
	});
});

describe("history", () => {
	test("pages, searches, and describes a commit with files and stats", async () => {
		const dir = fresh();
		for (let i = 0; i < 5; i++) {
			write(dir, `f${String(i)}.txt`, `line ${String(i)}\n`);
			await commitWorkbench({ cwd: dir, summary: i === 3 ? "needle commit" : `commit ${String(i)}` });
		}
		const page1 = await getLog({ cwd: dir, limit: 2 });
		expect(page1.commits).toHaveLength(2);
		expect(page1.hasMore).toBe(true);
		const page3 = await getLog({ cwd: dir, limit: 2, skip: 4 });
		expect(page3.commits).toHaveLength(1);
		expect(page3.hasMore).toBe(false);
		expect((await getLog({ cwd: dir, search: "NEEDLE" })).commits.map((c) => c.subject)).toEqual(["needle commit"]);
		expect(page1.commits[0]?.refs.join(",")).toContain("main");

		const detail = await getCommitDetail(dir, page3.commits[0]!.hash);
		expect(detail.commit.parents).toEqual([]);
		expect(detail.files).toEqual([{ path: "f0.txt", status: "A", additions: 1, deletions: 0, binary: false }]);
		const diff = await getRangeDiff({ cwd: dir, from: null, to: detail.commit.hash, file: "f0.txt" });
		expect(diff).toContain("+line 0");
	});

	test("handles renames, binary files and whitespace-only changes", async () => {
		const dir = fresh();
		write(dir, "a.txt", "alpha\nbeta\ngamma\ndelta\n");
		writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
		await commitWorkbench({ cwd: dir, summary: "base" });
		sh(dir, "mv", "a.txt", "b.txt");
		write(dir, "b.txt", "alpha\nbeta\ngamma\ndelta\nepsilon\n");
		writeFileSync(join(dir, "bin.dat"), Buffer.from([9, 9, 0, 1]));
		await commitWorkbench({ cwd: dir, summary: "rename and edit" });
		const log = await getLog({ cwd: dir });
		const detail = await getCommitDetail(dir, log.commits[0]!.hash);
		const rename = detail.files.find((f) => f.path === "b.txt");
		expect(rename).toMatchObject({ status: "R", oldPath: "a.txt", additions: 1, deletions: 0 });
		expect(detail.files.find((f) => f.path === "bin.dat")?.binary).toBe(true);
		const diff = await getRangeDiff({ cwd: dir, from: detail.commit.parents[0] ?? null, to: detail.commit.hash, file: "b.txt", oldPath: "a.txt" });
		expect(diff).toContain("rename from a.txt");

		write(dir, "b.txt", "alpha\n  beta\ngamma\ndelta\nepsilon\n");
		await commitWorkbench({ cwd: dir, summary: "indent" });
		const head = (await getLog({ cwd: dir })).commits[0]!;
		const loud = await getRangeDiff({ cwd: dir, from: head.parents[0] ?? null, to: head.hash, file: "b.txt" });
		const quiet = await getRangeDiff({ cwd: dir, from: head.parents[0] ?? null, to: head.hash, file: "b.txt", ignoreWhitespace: true });
		expect(loud).toContain("+  beta");
		expect(quiet.trim()).toBe("");
	});

	test("rejects revisions that would be read as options", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		await commitWorkbench({ cwd: dir, summary: "x" });
		expect(() => assertRevision("--output=/tmp/x")).toThrow();
		expect(() => assertRevision("a..b")).toThrow();
		expect(() => assertRevision("main")).not.toThrow();
		await expect(getCommitDetail(dir, "--help")).rejects.toThrow(/invalid/i);
		await expect(getRangeFiles({ cwd: dir, from: "-x", to: "HEAD" })).rejects.toThrow(/invalid/i);
	});

	test("compare finds the base branch and the files a branch adds", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		await commitWorkbench({ cwd: dir, summary: "base" });
		await branchAction({ cwd: dir, action: "create", name: "feature/x" });
		write(dir, "feat.txt", "f\n");
		await commitWorkbench({ cwd: dir, summary: "feature work" });
		const info = await getCompareInfo(dir);
		expect(info.base).toBe("main");
		expect(info.ahead).toBe(1);
		const files = await getRangeFiles({ cwd: dir, from: info.mergeBase, to: "HEAD" });
		expect(files.map((f) => f.path)).toEqual(["feat.txt"]);
		const log = await getLog({ cwd: dir, since: info.mergeBase! });
		expect(log.commits.map((c) => c.subject)).toEqual(["feature work"]);
	});

	test("revert makes a new commit, and abandons cleanly on conflict", async () => {
		const dir = fresh();
		write(dir, "a.txt", "1\n");
		await commitWorkbench({ cwd: dir, summary: "base" });
		write(dir, "a.txt", "2\n");
		await commitWorkbench({ cwd: dir, summary: "two" });
		const two = (await getLog({ cwd: dir })).commits[0]!;
		write(dir, "a.txt", "3\n");
		await commitWorkbench({ cwd: dir, summary: "three" });
		await expect(revertCommit(dir, two.hash)).rejects.toThrow();
		expect((await getStatus(dir)).files).toEqual([]);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("3\n");
		const three = (await getLog({ cwd: dir })).commits[0]!;
		await revertCommit(dir, three.hash);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("2\n");
		expect((await getLog({ cwd: dir })).commits[0]?.subject).toStartWith("Revert");
	});
});

describe("discard", () => {
	test("restores tracked files, removes untracked ones, and handles added and renamed files", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		write(dir, "r.txt", "r\n");
		await commitWorkbench({ cwd: dir, summary: "base" });
		write(dir, "a.txt", "changed\n");
		write(dir, "new.txt", "n\n");
		sh(dir, "add", "new.txt");
		write(dir, "loose.txt", "l\n");
		sh(dir, "mv", "r.txt", "moved.txt");
		await discardChanges({ cwd: dir, files: ["a.txt", "new.txt", "moved.txt", "loose.txt"] });
		expect((await getStatus(dir)).files).toEqual([]);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a\n");
		expect(existsSync(join(dir, "r.txt"))).toBe(true);
		expect(existsSync(join(dir, "new.txt"))).toBe(false);
	});

	test("only touches what was named, and everything when nothing is named", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		write(dir, "b.txt", "b\n");
		await commitWorkbench({ cwd: dir, summary: "base" });
		write(dir, "a.txt", "A\n");
		write(dir, "b.txt", "B\n");
		write(dir, "u.txt", "u\n");
		await discardChanges({ cwd: dir, files: ["a.txt"] });
		expect((await getStatus(dir)).files.map((f) => f.path)).toEqual(["b.txt", "u.txt"]);
		await discardChanges({ cwd: dir });
		expect((await getStatus(dir)).files).toEqual([]);
	});

	test("in a repository without commits, discarding removes the files", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		sh(dir, "add", "a.txt");
		write(dir, "b.txt", "b\n");
		await discardChanges({ cwd: dir });
		expect((await getStatus(dir)).files).toEqual([]);
	});
});

describe("branches", () => {
	test("create, switch, rename, delete; lists remote-only branches once", async () => {
		const origin = join(root, "origin-c.git");
		mkdirSync(origin);
		sh(origin, "init", "-q", "--bare", "-b", "main");
		const dir = fresh();
		sh(dir, "remote", "add", "origin", origin);
		write(dir, "a.txt", "a\n");
		await commitWorkbench({ cwd: dir, summary: "base" });
		await remoteAction({ cwd: dir, action: "push" });
		await branchAction({ cwd: dir, action: "create", name: "topic" });
		await remoteAction({ cwd: dir, action: "push" });
		await branchAction({ cwd: dir, action: "switch", name: "main" });
		sh(dir, "branch", "-D", "topic");
		let list = await listBranches(dir);
		expect(list.current).toBe("main");
		const names = list.branches.map((b) => [b.name, b.isRemote]);
		expect(names).toContainEqual(["main", false]);
		expect(names).toContainEqual(["origin/topic", true]);
		expect(names.filter(([name]) => name === "origin/main")).toEqual([]);

		await branchAction({ cwd: dir, action: "switch", name: "origin/topic" });
		list = await listBranches(dir);
		expect(list.current).toBe("topic");
		expect(list.branches.filter((b) => b.name === "origin/topic")).toEqual([]);
		await branchAction({ cwd: dir, action: "rename", name: "topic", newName: "topic-2" });
		expect((await listBranches(dir)).current).toBe("topic-2");
		await expect(branchAction({ cwd: dir, action: "delete", name: "topic-2" })).rejects.toThrow(/checked-out/);
		await branchAction({ cwd: dir, action: "switch", name: "main" });
		await branchAction({ cwd: dir, action: "delete", name: "topic-2" });
		expect((await listBranches(dir)).branches.map((b) => b.name)).not.toContain("topic-2");
	});

	test("rejects bad names and can branch from a commit", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		await commitWorkbench({ cwd: dir, summary: "one" });
		write(dir, "a.txt", "b\n");
		await commitWorkbench({ cwd: dir, summary: "two" });
		for (const bad of ["has space", "-flag", "a..b", "x~1", ""]) {
			await expect(branchAction({ cwd: dir, action: "create", name: bad })).rejects.toThrow();
		}
		const first = (await getLog({ cwd: dir })).commits[1]!;
		await branchAction({ cwd: dir, action: "create", name: "from-first", from: first.hash });
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a\n");
	});

	test("refuses to switch when local changes would be overwritten, and says why", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		await commitWorkbench({ cwd: dir, summary: "one" });
		await branchAction({ cwd: dir, action: "create", name: "other" });
		write(dir, "a.txt", "other\n");
		await commitWorkbench({ cwd: dir, summary: "other change" });
		await branchAction({ cwd: dir, action: "switch", name: "main" });
		write(dir, "a.txt", "dirty\n");
		await expect(branchAction({ cwd: dir, action: "switch", name: "other" })).rejects.toThrow(/overwritten|local changes/i);
		expect((await listBranches(dir)).current).toBe("main");
	});
});

describe("sync", () => {
	test("fetch shows incoming commits, pull merges them, push publishes", async () => {
		const origin = join(root, "origin-d.git");
		mkdirSync(origin);
		sh(origin, "init", "-q", "--bare", "-b", "main");
		const a = fresh();
		sh(a, "remote", "add", "origin", origin);
		write(a, "a.txt", "a\n");
		await commitWorkbench({ cwd: a, summary: "first" });
		await remoteAction({ cwd: a, action: "push" });

		const b = join(root, "clone-b");
		execFileSync("git", ["clone", "-q", origin, b], { env });
		write(b, "b.txt", "b\n");
		await commitWorkbench({ cwd: b, summary: "from b" });
		await remoteAction({ cwd: b, action: "push" });

		await remoteAction({ cwd: a, action: "fetch" });
		expect((await getStatus(a)).behind).toBe(1);
		await remoteAction({ cwd: a, action: "pull" });
		const status = await getStatus(a);
		expect(status.behind).toBe(0);
		expect(existsSync(join(a, "b.txt"))).toBe(true);
	});

	test("a conflicting pull leaves a merge the UI can see and abort", async () => {
		const origin = join(root, "origin-e.git");
		mkdirSync(origin);
		sh(origin, "init", "-q", "--bare", "-b", "main");
		const a = fresh();
		sh(a, "remote", "add", "origin", origin);
		write(a, "a.txt", "base\n");
		await commitWorkbench({ cwd: a, summary: "base" });
		await remoteAction({ cwd: a, action: "push" });
		const b = join(root, "clone-e");
		execFileSync("git", ["clone", "-q", origin, b], { env });
		write(b, "a.txt", "from b\n");
		await commitWorkbench({ cwd: b, summary: "b edit" });
		await remoteAction({ cwd: b, action: "push" });
		write(a, "a.txt", "from a\n");
		await commitWorkbench({ cwd: a, summary: "a edit" });
		await expect(remoteAction({ cwd: a, action: "pull" })).rejects.toThrow(/conflict/i);
		let status = await getStatus(a);
		expect(status.merging).toBe(true);
		expect(status.files[0]?.status).toBe("UU");
		await abortMerge(a);
		status = await getStatus(a);
		expect(status.merging).toBe(false);
		expect(readFileSync(join(a, "a.txt"), "utf8")).toBe("from a\n");
	});

	test("reports a missing remote and an unreachable one without hanging", async () => {
		const dir = fresh();
		write(dir, "a.txt", "a\n");
		await commitWorkbench({ cwd: dir, summary: "x" });
		await expect(remoteAction({ cwd: dir, action: "push" })).rejects.toThrow(/no remote/i);
		sh(dir, "remote", "add", "origin", join(root, "does-not-exist.git"));
		await expect(remoteAction({ cwd: dir, action: "fetch" })).rejects.toThrow();
		await expect(remoteAction({ cwd: dir, action: "pull" })).rejects.toThrow(/not been published/);
	});

	test("recognises credential failures so the signed-in account can be tried", () => {
		expect(isAuthFailure("fatal: Authentication failed for 'https://github.com/a/b.git/'")).toBe(true);
		expect(isAuthFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe(true);
		expect(isAuthFailure("fatal: unable to access: Could not resolve host")).toBe(false);
	});
});
