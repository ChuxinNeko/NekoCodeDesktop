import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/**
 * The project a working directory belongs to.
 *
 * A background task runs in a git worktree somewhere else on disk, and a
 * subfolder session runs below the root; both are still the same project, and
 * a project memory or a project-scoped hook written in one has to apply in the
 * others. So: the nearest directory holding `.git`, followed back to the main
 * checkout when that `.git` is a linked worktree's pointer file. A directory
 * outside any repository is its own project.
 */
export function projectRoot(cwd: string): string {
	return findRoot(cwd, true);
}

/**
 * The top of the checkout `cwd` is in — a linked worktree's own root, not the
 * main one. That is where files the agent reads from disk live: a worktree has
 * its own copy of AGENTS.md, and editing the main checkout's would change
 * nothing the worktree session sees.
 */
export function checkoutRoot(cwd: string): string {
	return findRoot(cwd, false);
}

function findRoot(cwd: string, followWorktree: boolean): string {
	const start = resolve(cwd);
	for (let dir = start; ; dir = dirname(dir)) {
		const marker = resolve(dir, ".git");
		try {
			const info = statSync(marker);
			if (info.isDirectory()) return dir;
			if (info.isFile()) return (followWorktree ? mainCheckoutOf(marker) : null) ?? dir;
		} catch {
			// No .git here; keep climbing.
		}
		if (dirname(dir) === dir) return start;
	}
}

/** `gitdir: <main>/.git/worktrees/<name>` → `<main>`, or null for anything else. */
function mainCheckoutOf(pointerFile: string): string | null {
	try {
		const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(pointerFile, "utf8"));
		if (!match) return null;
		const raw = match[1].trim();
		const gitdir = isAbsolute(raw) ? raw : resolve(dirname(pointerFile), raw);
		const worktrees = dirname(gitdir);
		if (basename(worktrees) !== "worktrees") return null;
		const common = dirname(worktrees);
		return basename(common) === ".git" ? dirname(common) : null;
	} catch {
		return null;
	}
}

/** A comparable form of a project path: Windows paths do not care about case. */
export function projectKey(path: string): string {
	const normalized = resolve(path).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function sameProject(a: string, b: string): boolean {
	return projectKey(a) === projectKey(b);
}
