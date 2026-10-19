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

export interface GitRunOptions {
  /** Extra environment variables for this one call. */
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this many milliseconds. */
  timeout?: number;
}

/**
 * Run git in `cwd` and return stdout.
 *
 * Every call treats pathspecs literally, so a file called `a[1].ts` or `*.log`
 * is that file and not a glob, and read-only calls never take the optional index
 * lock, so polling `status` cannot make a commit in progress fail.
 *
 * A failure is thrown with git's own explanation as its message: git says why it
 * refused on stderr (or, for `commit`, on stdout) and the default
 * "Command failed with exit code 1" would throw the useful part away. The
 * original `stdout`, `stderr` and `code` stay on the error for callers that need
 * them — `diff --no-index` exits 1 when files differ.
 */
export async function git(cwd: string, args: string[], options: GitRunOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      env: {
        ...process.env,
        GIT_LITERAL_PATHSPECS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        ...options.env,
      },
    });
    return stdout;
  } catch (error) {
    if (isMissingExecutable(error)) throw new GitUnavailableError(error);
    const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown };
    const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
    const stdout = typeof failure.stdout === "string" ? failure.stdout.trim() : "";
    const detail = failure.killed === true
      ? "git did not finish in time and was stopped."
      : [stderr, stdout].filter(Boolean).join("\n").slice(0, 2000) ||
        (error instanceof Error ? error.message : String(error));
    const wrapped = new Error(detail);
    Object.assign(wrapped, { stdout: failure.stdout, stderr: failure.stderr, code: failure.code });
    throw wrapped;
  }
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch (error) {
    if (error instanceof GitUnavailableError) throw error;
    return false;
  }
}

const toplevelCache = new Map<string, string>();

/**
 * The top of the working tree `cwd` sits in. `git status` reports paths from
 * there, while a pathspec is read from the directory git runs in, so a project
 * opened on a subfolder would otherwise ask for `src/a.ts` and mean `sub/src/a.ts`.
 * Falls back to `cwd` itself when it is not inside a repository.
 */
export async function toplevel(cwd: string): Promise<string> {
  const known = toplevelCache.get(cwd);
  if (known) return known;
  try {
    const top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (top) {
      toplevelCache.set(cwd, top);
      return top;
    }
  } catch (error) {
    if (error instanceof GitUnavailableError) throw error;
  }
  return cwd;
}

/** The object id of the empty tree: what a root commit is diffed against. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** First ref that resolves: origin/HEAD, origin/main, main, master… */
export async function detectBaseBranch(cwd: string): Promise<string | null> {
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

/**
 * Parse `git diff --numstat -z`: `added<TAB>removed<TAB>path<NUL>`, where a
 * rename is `added<TAB>removed<TAB><NUL>old<NUL>new<NUL>`. Binary files report `-`.
 */
export function parseNumstatZ(
  text: string,
): Map<string, { additions: number; deletions: number; binary: boolean; oldPath?: string }> {
  const map = new Map<string, { additions: number; deletions: number; binary: boolean; oldPath?: string }>();
  const tokens = text.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token);
    if (!match) continue;
    const binary = match[1] === "-" || match[2] === "-";
    const stat = {
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    };
    if (match[3] === "") {
      const oldPath = tokens[index + 1] ?? "";
      const path = tokens[index + 2] ?? "";
      index += 2;
      if (path) map.set(path, { ...stat, oldPath });
    } else {
      map.set(match[3], stat);
    }
  }
  return map;
}

/** Files that are changed relative to HEAD, with line counts. */
async function statsAgainstHead(
  cwd: string,
  hasCommits: boolean,
): Promise<Map<string, { additions: number; deletions: number }>> {
  const base = ["diff", "--numstat", "-z", "--no-color", "--no-ext-diff"];
  if (hasCommits) {
    return parseNumstatZ(await git(cwd, [...base, "HEAD", "--"]).catch(() => ""));
  }
  // No HEAD yet: what is staged is everything there will be to commit.
  const merged = new Map<string, { additions: number; deletions: number }>();
  for (const args of [[...base, "--cached", "--"], [...base, "--"]]) {
    for (const [path, stat] of parseNumstatZ(await git(cwd, args).catch(() => ""))) {
      const previous = merged.get(path);
      merged.set(path, {
        additions: (previous?.additions ?? 0) + stat.additions,
        deletions: (previous?.deletions ?? 0) + stat.deletions,
      });
    }
  }
  return merged;
}

/** Cap on rows the status carries, so an unignored `node_modules` cannot freeze the UI. */
const MAX_STATUS_FILES = 5000;

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

  cwd = await toplevel(cwd);
  const hasCommits = await gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const first = async (args: string[]) => (await git(cwd, args).catch(() => "")).trim() || null;
  const [porcelain, branch, baseBranch, upstream, remote, top, lastRaw] = await Promise.all([
    git(cwd, ["status", "--porcelain=v1", "-z", "-uall"]),
    git(cwd, ["branch", "--show-current"]).then((s) => s.trim() || null),
    detectBaseBranch(cwd),
    first(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    git(cwd, ["remote"]).then((s) => s.split("\n").map((n) => n.trim()).find(Boolean) ?? null, () => null),
    first(["rev-parse", "--show-toplevel"]),
    hasCommits ? first(["log", "-1", "--format=%H%x1f%h%x1f%s"]) : Promise.resolve(null),
  ]);
  const numstat = await statsAgainstHead(cwd, hasCommits);

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = (await first(["rev-list", "--left-right", "--count", "HEAD...@{u}"]))?.split(/\s+/) ?? [];
    ahead = Number(counts[0]) || 0;
    behind = Number(counts[1]) || 0;
  }

  const files: ChangedFile[] = [];
  const tokens = porcelain.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    let oldPath: string | undefined;
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
      oldPath = tokens[index + 1];
      index += 1;
    }
    const untracked = status === "??";
    const stat = numstat.get(path) ?? { additions: 0, deletions: 0 };
    files.push({
      path,
      status,
      untracked,
      staged: !untracked && status[0] !== " " && status[0] !== "?",
      ...stat,
      ...(oldPath ? { oldPath } : {}),
    });
  }
  files.sort((x, y) => x.path.localeCompare(y.path));

  const merging = await gitOk(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);

  let lastCommit: RepoStatus["lastCommit"] = null;
  if (lastRaw) {
    const [hash = "", shortHash = "", subject = ""] = lastRaw.split("\x1f");
    lastCommit = { hash, shortHash, subject, pushed: upstream !== null && ahead === 0 };
  }

  return {
    isRepo: true,
    gitAvailable: true,
    branch,
    baseBranch,
    files: files.slice(0, MAX_STATUS_FILES),
    repoName: top ? (top.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? undefined) : undefined,
    hasCommits,
    upstream,
    remote,
    ahead,
    behind,
    merging,
    detachedAt: !branch && hasCommits ? await first(["rev-parse", "--short", "HEAD"]) : null,
    lastCommit,
    ...(files.length > MAX_STATUS_FILES ? { truncated: true } : {}),
  };
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

/** Flags every diff shares: no colour codes, no external tool, renames detected. */
function diffFlags(ignoreWhitespace?: boolean): string[] {
  return ["diff", "--no-color", "--no-ext-diff", "-M", ...(ignoreWhitespace ? ["-w"] : [])];
}

/** `git diff` is empty for an untracked file; synthesize one against /dev/null. */
async function untrackedDiff(cwd: string, file: string, ignoreWhitespace?: boolean): Promise<string> {
  try {
    return await git(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      ...(ignoreWhitespace ? ["-w"] : []),
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

async function isUntracked(cwd: string, file: string): Promise<boolean> {
  const status = await git(cwd, ["status", "--porcelain", "-uall", "--", file]);
  return status.startsWith("??");
}

export async function getDiff(req: GitDiffRequest): Promise<string> {
  const { scope, file, ignoreWhitespace } = req;
  const cwd = await toplevel(req.cwd);
  const target = file ? ["--", ...(req.oldPath && req.oldPath !== file ? [req.oldPath] : []), file] : [];
  const flags = diffFlags(ignoreWhitespace);

  switch (scope) {
    case "unstaged":
      if (file && (await isUntracked(cwd, file))) return untrackedDiff(cwd, file, ignoreWhitespace);
      return git(cwd, [...flags, ...target]);
    case "head": {
      // Everything that would be committed, staged or not, against HEAD.
      if (file && (await isUntracked(cwd, file))) return untrackedDiff(cwd, file, ignoreWhitespace);
      const hasHead = await gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      return git(cwd, [...flags, hasHead ? "HEAD" : EMPTY_TREE, ...target]);
    }
    case "staged":
      return git(cwd, [...flags, "--cached", ...target]);
    case "branch": {
      const mergeBase = await baseMergePoint(cwd);
      if (!mergeBase) return "";
      return git(cwd, [...flags, `${mergeBase}...HEAD`, ...target]);
    }
    case "lastturn":
      // Placeholder until the agent runtime reports per-turn changes:
      // show the most recent commit's diff.
      if (!(await gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD~1"]))) {
        return git(cwd, ["show", "--format=", "--no-color", "HEAD", ...target]).catch(() => "");
      }
      return git(cwd, [...flags, "HEAD~1...HEAD", ...target]);
  }
}

export async function listScopeFiles(
  start: string,
  scope: GitDiffRequest["scope"],
): Promise<string[]> {
  const cwd = await toplevel(start);
  const names = async (args: string[]) =>
    (await git(cwd, args)).split("\n").filter(Boolean);

  switch (scope) {
    case "unstaged": {
      const modified = await names(["diff", "--name-only"]);
      const untracked = await names(["ls-files", "--others", "--exclude-standard"]);
      return [...new Set([...modified, ...untracked])];
    }
    case "head": {
      const modified = await names(["diff", "--name-only", (await gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])) ? "HEAD" : EMPTY_TREE]);
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

/**
 * A file as committed at HEAD — the original side of the editor's diff view.
 * Null when there is no such file there: new, untracked, or no commits yet.
 */
export async function showHeadFile(cwd: string, relPath: string): Promise<string | null> {
  const path = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  try {
    // `./` makes the path relative to cwd rather than the repository root.
    return await git(cwd, ["show", `HEAD:./${path}`]);
  } catch (error) {
    if (error instanceof GitUnavailableError) throw error;
    return null;
  }
}

/**
 * Commit what is staged — or, with `all`, everything, the way an editor's
 * commit button does when nothing was staged first.
 */
export async function commitChanges(cwd: string, message: string, all: boolean): Promise<void> {
  const text = message.trim();
  if (!text) throw new Error("Commit message required");
  if (all) await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", text]);
}

export async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init"]);
}

export async function applyAction(req: GitActionRequest): Promise<void> {
  const { action, file } = req;
  const cwd = await toplevel(req.cwd);
  const target = file ? ["--", file] : [];

  switch (action) {
    case "stage":
      await git(cwd, file ? ["add", ...target] : ["add", "-A"]);
      return;
    case "unstage":
      if (!(await gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]))) {
        // Nothing to restore from yet: drop the path from the index instead.
        await git(cwd, file ? ["rm", "-r", "--cached", "-q", ...target] : ["rm", "-r", "--cached", "-q", "."]).catch(() => undefined);
        return;
      }
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
