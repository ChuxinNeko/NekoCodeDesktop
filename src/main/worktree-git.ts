import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitUnavailableError } from "./git";

const execFileP = promisify(execFile);

function isMissingExecutable(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

/**
 * Run git, surfacing stderr in the thrown message.
 *
 * `git worktree` and `git merge` say why they refused on stderr and put nothing
 * on stdout, so the default "Command failed with exit code 128" would throw
 * away the only part worth showing the user.
 */
export async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
		return stdout;
	} catch (error) {
		if (isMissingExecutable(error)) throw new GitUnavailableError(error);
		const stderr = (error as { stderr?: unknown }).stderr;
		const detail = typeof stderr === "string" ? stderr.trim() : "";
		throw new Error(detail || (error instanceof Error ? error.message : String(error)));
	}
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
	try {
		await git(cwd, args);
		return true;
	} catch (error) {
		if (error instanceof GitUnavailableError) throw error;
		return false;
	}
}

/** The top of the working tree `cwd` sits in, or null when it is not in one. */
export async function repoRoot(cwd: string): Promise<string | null> {
	try {
		const top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
		return top || null;
	} catch {
		return null;
	}
}

/**
 * The branch a worktree would fork from.
 *
 * A detached HEAD has no branch name to merge back into later, so it is
 * reported as null and the caller declines to isolate rather than creating a
 * task whose work has nowhere to go.
 */
export async function currentBranch(cwd: string): Promise<string | null> {
	const name = (await git(cwd, ["branch", "--show-current"])).trim();
	return name || null;
}

/** False for a repository with no commits, where `worktree add` has no base. */
export async function hasCommits(cwd: string): Promise<boolean> {
	return gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
}

/** Nothing staged, modified, or untracked. */
export async function isClean(cwd: string): Promise<boolean> {
	return (await git(cwd, ["status", "--porcelain"])).trim().length === 0;
}

export async function countDirtyFiles(cwd: string): Promise<number> {
	const out = await git(cwd, ["status", "--porcelain"]);
	return out.split("\n").filter((line) => line.trim().length > 0).length;
}

/** Commits on `branch` that `base` does not have. */
export async function countAhead(cwd: string, base: string, branch: string): Promise<number> {
	try {
		const out = await git(cwd, ["rev-list", "--count", `${base}..${branch}`]);
		return Number(out.trim()) || 0;
	} catch {
		return 0;
	}
}

export async function addWorktree(options: {
	repoRoot: string;
	path: string;
	branch: string;
	/** The commit-ish the new branch starts at. */
	from: string;
}): Promise<void> {
	await git(options.repoRoot, [
		"worktree", "add", "-b", options.branch, options.path, options.from,
	]);
}

/**
 * Take a worktree back out, branch included.
 *
 * `--force` because the whole point of the directory is to hold uncommitted
 * work: without it git refuses to remove exactly the worktrees this is for.
 * Failures are swallowed per step — a directory the user already deleted by
 * hand must still leave the branch and the admin entry cleanable.
 */
export async function removeWorktree(options: {
	repoRoot: string;
	path: string;
	branch: string;
}): Promise<void> {
	await gitOk(options.repoRoot, ["worktree", "remove", "--force", options.path]);
	await gitOk(options.repoRoot, ["worktree", "prune"]);
	await gitOk(options.repoRoot, ["branch", "-D", options.branch]);
}

/** Commit everything in the worktree. Returns false when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
	if (await isClean(cwd)) return false;
	await git(cwd, ["add", "-A"]);
	await git(cwd, ["commit", "-m", message]);
	return true;
}

/**
 * Merge a task branch into the branch checked out at `repoRoot`.
 *
 * A conflicted merge is aborted rather than left in place: the main checkout is
 * the user's, and finding it mid-merge because a background task they had
 * forgotten about finished is not an outcome anyone asked for.
 */
export async function mergeBranch(repoRootPath: string, branch: string): Promise<void> {
	try {
		await git(repoRootPath, ["merge", "--no-ff", branch]);
	} catch (error) {
		await gitOk(repoRootPath, ["merge", "--abort"]);
		throw error;
	}
}

