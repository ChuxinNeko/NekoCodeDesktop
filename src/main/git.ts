import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ChangedFile,
  GitActionRequest,
  GitDiffRequest,
  RepoStatus,
} from "../shared/git";

const execFileP = promisify(execFile);

/**
 * Raised when the `git` executable cannot be spawned at all. Every other failure
 * (non-zero exit, "not a repository") is an ordinary Error. The distinction drives
 * the UI: a missing binary is an install problem, a non-repository is not.
 */
export class GitUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "git executable not found on PATH. Install Git, or open a folder that does not need version control.",
    );
    this.name = "GitUnavailableError";
    this.cause = cause;
  }
}

function isMissingExecutable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isMissingExecutable(error)) throw new GitUnavailableError(error);
    throw error;
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

/** First ref that resolves: origin/HEAD, origin/main, main, master… */
async function detectBaseBranch(cwd: string): Promise<string | null> {
  for (const ref of ["origin/HEAD", "origin/main", "main", "master"]) {
    if (await gitOk(cwd, ["rev-parse", "--verify", "--quiet", ref])) {
      if (ref === "origin/HEAD") {
        const name = (
          await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        ).trim();
        return name || ref;
      }
      return ref;
    }
  }
  return null;
}

function parseNumstat(text: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    map.set(path, {
      additions: a === "-" ? 0 : Number(a) || 0,
      deletions: d === "-" ? 0 : Number(d) || 0,
    });
  }
  return map;
}

export async function getStatus(cwd: string): Promise<RepoStatus> {
  let isRepo: boolean;
  try {
    isRepo = await gitOk(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    if (error instanceof GitUnavailableError) {
      return {
        isRepo: false,
        gitAvailable: false,
        branch: null,
        baseBranch: null,
        files: [],
        gitError: error.message,
      };
    }
    throw error;
  }
  if (!isRepo) {
    return { isRepo: false, gitAvailable: true, branch: null, baseBranch: null, files: [] };
  }

  const [porcelain, branch, baseBranch] = await Promise.all([
    git(cwd, ["status", "--porcelain"]),
    git(cwd, ["branch", "--show-current"]).then((s) => s.trim() || null),
    detectBaseBranch(cwd),
  ]);
  const numstat = parseNumstat(await git(cwd, ["diff", "--numstat", "HEAD", "--"]));

  const files: ChangedFile[] = porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const path = line.slice(3).trim();
      const untracked = status === "??";
      const stat = numstat.get(path) ?? { additions: 0, deletions: 0 };
      return {
        path,
        status,
        untracked,
        staged: !untracked && status[0] !== " " && status[0] !== "?",
        ...stat,
      };
    });

  return { isRepo: true, gitAvailable: true, branch, baseBranch, files };
}

async function baseMergePoint(cwd: string): Promise<string | null> {
  const base = await detectBaseBranch(cwd);
  if (!base) return null;
  try {
    return (await git(cwd, ["merge-base", "HEAD", base])).trim();
  } catch {
    return base;
  }
}

export async function getDiff(req: GitDiffRequest): Promise<string> {
  const { cwd, scope, file } = req;
  const target = file ? ["--", file] : [];

  switch (scope) {
    case "unstaged":
      if (file) {
        // `git diff` is empty for untracked files; synthesize one vs /dev/null.
        const status = await git(cwd, ["status", "--porcelain", "--", file]);
        if (status.startsWith("??")) {
          try {
            return await git(cwd, [
              "diff",
              "--no-index",
              "--",
              "/dev/null",
              file,
            ]);
          } catch (e) {
            // diff --no-index exits 1 when files differ; stdout still has the diff
            return (e as { stdout?: string }).stdout ?? "";
          }
        }
      }
      return git(cwd, ["diff", ...target]);
    case "staged":
      return git(cwd, ["diff", "--cached", ...target]);
    case "branch": {
      const mergeBase = await baseMergePoint(cwd);
      if (!mergeBase) return "";
      return git(cwd, ["diff", `${mergeBase}...HEAD`, ...target]);
    }
    case "lastturn":
      // Placeholder until the agent runtime reports per-turn changes:
      // show the most recent commit's diff.
      if (!(await gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD~1"]))) {
        return git(cwd, ["show", "--format=", "HEAD", ...target]).catch(() => "");
      }
      return git(cwd, ["diff", "HEAD~1...HEAD", ...target]);
  }
}

export async function listScopeFiles(
  cwd: string,
  scope: GitDiffRequest["scope"],
): Promise<string[]> {
  const names = async (args: string[]) =>
    (await git(cwd, args)).split("\n").filter(Boolean);

  switch (scope) {
    case "unstaged": {
      const modified = await names(["diff", "--name-only"]);
      const untracked = await names(["ls-files", "--others", "--exclude-standard"]);
      return [...new Set([...modified, ...untracked])];
    }
    case "staged":
      return names(["diff", "--cached", "--name-only"]);
    case "branch": {
      const mergeBase = await baseMergePoint(cwd);
      return mergeBase ? names(["diff", "--name-only", `${mergeBase}...HEAD`]) : [];
    }
    case "lastturn":
      if (!(await gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD~1"]))) {
        return names(["show", "--name-only", "--format=", "HEAD"]);
      }
      return names(["diff", "--name-only", "HEAD~1...HEAD"]);
  }
}

export async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init"]);
}

export async function applyAction(req: GitActionRequest): Promise<void> {
  const { cwd, action, file } = req;
  const target = file ? ["--", file] : [];

  switch (action) {
    case "stage":
      await git(cwd, file ? ["add", ...target] : ["add", "-A"]);
      return;
    case "unstage":
      await git(cwd, file ? ["restore", "--staged", ...target] : ["reset", "-q"]);
      return;
    case "revert":
      if (file) {
        const status = await git(cwd, ["status", "--porcelain", "--", file]);
        if (status.startsWith("??")) {
          await git(cwd, ["clean", "-f", ...target]);
        } else {
          await git(cwd, ["restore", ...target]);
        }
      } else {
        // Revert tracked modifications only; never bulk-delete untracked files.
        await git(cwd, ["restore", "."]);
      }
      return;
  }
}
