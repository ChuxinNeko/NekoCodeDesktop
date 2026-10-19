// FILE: git-workbench.ts
// Purpose: The git operations behind the Review workbench — history, commit,
//          branches, sync — kept apart from git.ts, which is the status/diff core.
// Layer: Main process service

import { EMPTY_TREE, git, GitUnavailableError, gitOk, parseNumstatZ, toplevel, detectBaseBranch } from "./git";
import type {
  GitBranch,
  GitBranchActionRequest,
  GitBranchList,
  GitCommit,
  GitCommitDetail,
  GitCommitRequest,
  GitCommitResult,
  GitCompareInfo,
  GitDiscardRequest,
  GitFileChange,
  GitLogRequest,
  GitLogResult,
  GitRangeDiffRequest,
  GitRangeRequest,
  GitRemoteActionRequest,
  GitUndoCommitResult,
} from "../shared/git";

const FIELD = "\x1f";
const RECORD = "\x1e";
const COMMIT_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%s", "%D"].join("%x1f");
const DEFAULT_PAGE = 60;
const MAX_PAGE = 300;
/** Paths per `add`/`restore`/`clean` call, to stay under the OS argument limit. */
const PATH_CHUNK = 200;

/**
 * A revision or branch name as the renderer may hand it over. Anything starting
 * with `-` would be read by git as an option, so it is refused here rather than
 * trusted to the caller.
 */
export function assertRevision(value: unknown, what = "revision"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`Invalid ${what}`);
  }
  if (value.startsWith("-") || /[\s\0\\:?*[]/.test(value) || value.includes("..")) {
    throw new Error(`Invalid ${what}: ${value}`);
  }
  return value;
}

function cleanPaths(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  const unique = new Set<string>();
  for (const file of files) {
    if (typeof file !== "string" || !file || file.includes("\0")) continue;
    unique.add(file);
  }
  return [...unique];
}

async function inChunks(paths: string[], run: (chunk: string[]) => Promise<unknown>): Promise<void> {
  for (let index = 0; index < paths.length; index += PATH_CHUNK) {
    await run(paths.slice(index, index + PATH_CHUNK));
  }
}

async function hasHead(cwd: string): Promise<boolean> {
  return gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
}

async function upstreamOf(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim() || null;
  } catch (error) {
    if (error instanceof GitUnavailableError) throw error;
    return null;
  }
}

// --- history ----------------------------------------------------------------

function parseCommit(record: string, unpushed: Set<string>): GitCommit | null {
  const [hash, parents, author, email, date, subject, refs] = record.replace(/^\n+/, "").split(FIELD);
  if (!hash || hash.length < 7) return null;
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: (parents ?? "").split(" ").filter(Boolean),
    author: author ?? "",
    email: email ?? "",
    date: date ?? "",
    subject: subject ?? "",
    refs: (refs ?? "").split(", ").map((ref) => ref.trim()).filter(Boolean),
    unpushed: unpushed.has(hash),
  };
}

export async function getLog(req: GitLogRequest): Promise<GitLogResult> {
  const cwd = await toplevel(req.cwd);
  if (!(await hasHead(cwd))) return { commits: [], hasMore: false };
  const limit = Math.min(Math.max(Math.trunc(req.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);
  const skip = Math.max(Math.trunc(req.skip ?? 0), 0);
  const args = [
    "log",
    "--no-color",
    `--format=${COMMIT_FORMAT}${RECORD}`,
    `-n${String(limit + 1)}`,
    `--skip=${String(skip)}`,
  ];
  const search = req.search?.trim();
  if (search) args.push("--regexp-ignore-case", "--fixed-strings", `--grep=${search}`);
  args.push(req.since ? `${assertRevision(req.since)}..HEAD` : "HEAD", "--");

  const unpushed = new Set<string>();
  const upstream = await upstreamOf(cwd);
  if (upstream) {
    const out = await git(cwd, ["rev-list", "--max-count=2000", "@{u}..HEAD"]).catch(() => "");
    for (const hash of out.split("\n")) if (hash) unpushed.add(hash);
  }

  const out = await git(cwd, args);
  const commits = out
    .split(RECORD)
    .map((record) => parseCommit(record, unpushed))
    .filter((commit): commit is GitCommit => commit !== null);
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

/** The files a change between two revisions touches, with line counts. */
export async function getRangeFiles(req: GitRangeRequest): Promise<GitFileChange[]> {
  const cwd = await toplevel(req.cwd);
  const from = req.from === null ? EMPTY_TREE : assertRevision(req.from);
  const to = assertRevision(req.to);
  const flags = ["--no-color", "--no-ext-diff", "-M", "-z"];
  const [nameStatus, numstat] = await Promise.all([
    git(cwd, ["diff", "--name-status", ...flags, from, to, "--"]),
    git(cwd, ["diff", "--numstat", ...flags, from, to, "--"]),
  ]);
  const stats = parseNumstatZ(numstat);

  const files: GitFileChange[] = [];
  const tokens = nameStatus.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const code = tokens[index] ?? "";
    if (!code) continue;
    const letter = code[0] ?? "M";
    let path: string;
    let oldPath: string | undefined;
    if (letter === "R" || letter === "C") {
      oldPath = tokens[index + 1];
      path = tokens[index + 2] ?? "";
      index += 2;
    } else {
      path = tokens[index + 1] ?? "";
      index += 1;
    }
    if (!path) continue;
    const stat = stats.get(path);
    files.push({
      path,
      status: letter,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary: stat?.binary ?? false,
      ...(oldPath ? { oldPath } : {}),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function getRangeDiff(req: GitRangeDiffRequest): Promise<string> {
  const cwd = await toplevel(req.cwd);
  const from = req.from === null ? EMPTY_TREE : assertRevision(req.from);
  const to = assertRevision(req.to);
  if (typeof req.file !== "string" || !req.file) throw new Error("A file is required");
  const paths = req.oldPath && req.oldPath !== req.file ? [req.oldPath, req.file] : [req.file];
  return git(cwd, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "-M",
    ...(req.ignoreWhitespace ? ["-w"] : []),
    from,
    to,
    "--",
    ...paths,
  ]);
}

export async function getCommitDetail(cwd: string, hash: string): Promise<GitCommitDetail> {
  const root = await toplevel(cwd);
  const rev = assertRevision(hash, "commit");
  const out = await git(root, [
    "show",
    "-s",
    "--no-color",
    `--format=${COMMIT_FORMAT}%x1f%b${RECORD}`,
    rev,
    "--",
  ]);
  const [head = ""] = out.split(RECORD);
  const fields = head.replace(/^\n+/, "").split(FIELD);
  const commit = parseCommit(fields.slice(0, 7).join(FIELD), new Set());
  if (!commit) throw new Error(`Unknown commit: ${hash}`);
  const body = fields.slice(7).join(FIELD).trim();
  const files = await getRangeFiles({ cwd: root, from: commit.parents[0] ?? null, to: commit.hash });
  return { commit, body, files };
}

/** The base branch the current one is reviewed against, and how far they have drifted. */
export async function getCompareInfo(cwd: string): Promise<GitCompareInfo> {
  const root = await toplevel(cwd);
  const base = await detectBaseBranch(root);
  if (!base || !(await hasHead(root))) return { base, mergeBase: null, ahead: 0, behind: 0 };
  let mergeBase: string | null = null;
  try {
    mergeBase = (await git(root, ["merge-base", "HEAD", base])).trim() || null;
  } catch {
    mergeBase = null;
  }
  const counts = (await git(root, ["rev-list", "--left-right", "--count", `HEAD...${base}`]).catch(() => ""))
    .trim()
    .split(/\s+/);
  return { base, mergeBase, ahead: Number(counts[0]) || 0, behind: Number(counts[1]) || 0 };
}

// --- commit -----------------------------------------------------------------

/**
 * Commit the chosen files, the way GitHub Desktop does: the index is rebuilt
 * from the selection, so a file the user unticked stays a plain working-tree
 * change instead of sneaking into the commit because it was staged earlier.
 * `files` omitted commits everything.
 */
export async function commitWorkbench(req: GitCommitRequest): Promise<GitCommitResult> {
  const cwd = await toplevel(req.cwd);
  const summary = String(req.summary ?? "").trim();
  if (!summary) throw new Error("A commit summary is required.");
  const description = String(req.description ?? "").trim();
  const message = ["-m", summary, ...(description ? ["-m", description] : [])];

  const merging = await gitOk(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (req.files === undefined || merging) {
    await git(cwd, ["add", "-A"]);
  } else {
    const files = cleanPaths(req.files);
    // Amending with nothing ticked just rewrites the message of the last commit.
    if (files.length === 0 && req.amend !== true) throw new Error("Select at least one file to commit.");
    if (await hasHead(cwd)) await git(cwd, ["reset", "-q"]);
    else await git(cwd, ["rm", "-r", "--cached", "-q", "."]).catch(() => undefined);
    await inChunks(files, (chunk) => git(cwd, ["add", "-A", "--", ...chunk]));
  }

  await git(cwd, ["commit", ...(req.amend === true ? ["--amend"] : []), ...message]);
  const hash = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  return { hash, shortHash: hash.slice(0, 7) };
}

/**
 * Take back the newest commit, keeping its changes staged, and hand its message
 * back so the box can be refilled. Refused once the commit is on the upstream
 * branch — rewriting what others may have pulled is not an "undo".
 */
export async function undoLastCommit(cwdInput: string): Promise<GitUndoCommitResult> {
  const cwd = await toplevel(cwdInput);
  if (!(await hasHead(cwd))) throw new Error("There is no commit to undo.");
  if ((await upstreamOf(cwd)) !== null) {
    const ahead = Number((await git(cwd, ["rev-list", "--count", "@{u}..HEAD"]).catch(() => "0")).trim()) || 0;
    if (ahead === 0) throw new Error("The latest commit has already been pushed, so it cannot be undone here.");
  }
  const summary = (await git(cwd, ["log", "-1", "--format=%s"])).trim();
  const description = (await git(cwd, ["log", "-1", "--format=%b"])).trim();
  const hasParent = await gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD~1"]);
  if (hasParent) await git(cwd, ["reset", "--soft", "HEAD~1"]);
  else await git(cwd, ["update-ref", "-d", "HEAD"]);
  return { summary, description };
}

/** Add a new commit that undoes `hash`; abandons cleanly if it conflicts. */
export async function revertCommit(cwdInput: string, hash: string): Promise<void> {
  const cwd = await toplevel(cwdInput);
  const rev = assertRevision(hash, "commit");
  const parents = (await git(cwd, ["rev-list", "--parents", "-n1", rev])).trim().split(" ").length - 1;
  try {
    await git(cwd, ["revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), rev]);
  } catch (error) {
    await git(cwd, ["revert", "--abort"]).catch(() => undefined);
    throw error;
  }
}

export async function abortMerge(cwdInput: string): Promise<void> {
  const cwd = await toplevel(cwdInput);
  await git(cwd, ["merge", "--abort"]);
}

/**
 * Throw changes away: tracked files go back to HEAD (staged side too), untracked
 * ones are deleted. `files` omitted means everything, which is the one place an
 * untracked file is removed in bulk — and only because the caller asked by name.
 */
export async function discardChanges(req: GitDiscardRequest): Promise<void> {
  const cwd = await toplevel(req.cwd);
  const head = await hasHead(cwd);
  const porcelain = await git(cwd, ["status", "--porcelain=v1", "-z", "-uall"]);
  const entries: { path: string; untracked: boolean; oldPath?: string }[] = [];
  const tokens = porcelain.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const item: { path: string; untracked: boolean; oldPath?: string } = { path: entry.slice(3), untracked: status === "??" };
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
      item.oldPath = tokens[index + 1];
      index += 1;
    }
    entries.push(item);
  }

  const wanted = req.files === undefined ? null : new Set(cleanPaths(req.files));
  const chosen = entries.filter((entry) => wanted === null || wanted.has(entry.path));

  const untracked = chosen.filter((entry) => entry.untracked).map((entry) => entry.path);
  const tracked = chosen.filter((entry) => !entry.untracked);
  const restore = new Set<string>();
  for (const entry of tracked) {
    restore.add(entry.path);
    if (entry.oldPath) restore.add(entry.oldPath);
  }

  if (head) {
    await inChunks([...restore], (chunk) =>
      git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...chunk]).catch(async () => {
        // A path HEAD does not know (an added file) cannot be restored: remove it.
        for (const path of chunk) {
          await git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", path]).catch(() =>
            git(cwd, ["rm", "-f", "-q", "--", path]).catch(() => undefined),
          );
        }
      }),
    );
  } else {
    await inChunks([...restore], (chunk) => git(cwd, ["rm", "-f", "-q", "--", ...chunk]).catch(() => undefined));
  }
  await inChunks(untracked, (chunk) => git(cwd, ["clean", "-f", "-q", "--", ...chunk]));
}

// --- branches ---------------------------------------------------------------

export async function listBranches(cwdInput: string): Promise<GitBranchList> {
  const cwd = await toplevel(cwdInput);
  const format = ["%(refname)", "%(refname:short)", "%(HEAD)", "%(upstream:short)", "%(committerdate:iso-strict)"].join(FIELD);
  const out = await git(cwd, [
    "for-each-ref",
    "--sort=-committerdate",
    `--format=${format}`,
    "refs/heads",
    "refs/remotes",
  ]);
  const locals: GitBranch[] = [];
  const remotes: GitBranch[] = [];
  let current: string | null = null;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [ref = "", short = "", head = "", upstream = "", date = ""] = line.split(FIELD);
    if (ref.endsWith("/HEAD")) continue;
    const isRemote = ref.startsWith("refs/remotes/");
    const branch: GitBranch = {
      name: short,
      isRemote,
      current: head === "*",
      upstream: upstream || null,
      date: date || null,
    };
    if (branch.current) current = short;
    (isRemote ? remotes : locals).push(branch);
  }
  // A remote branch that already has a local twin is the same branch listed twice.
  const tracking = new Set(locals.map((branch) => branch.upstream).filter((name): name is string => name !== null));
  const localNames = new Set(locals.map((branch) => branch.name));
  const onlyRemote = remotes.filter((branch) => {
    if (tracking.has(branch.name)) return false;
    const slash = branch.name.indexOf("/");
    return !localNames.has(slash >= 0 ? branch.name.slice(slash + 1) : branch.name);
  });
  return { current, branches: [...locals, ...onlyRemote] };
}

async function assertBranchName(cwd: string, name: string): Promise<string> {
  assertRevision(name, "branch name");
  try {
    await git(cwd, ["check-ref-format", "--branch", name]);
  } catch {
    throw new Error(`"${name}" is not a valid branch name.`);
  }
  return name;
}

export async function branchAction(req: GitBranchActionRequest): Promise<void> {
  const cwd = await toplevel(req.cwd);
  switch (req.action) {
    case "switch": {
      const name = assertRevision(req.name, "branch");
      const branches = await listBranches(cwd);
      const target = branches.branches.find((branch) => branch.name === name);
      if (target?.isRemote) {
        await git(cwd, ["checkout", "--track", name]);
      } else {
        await git(cwd, ["checkout", name, "--"]);
      }
      return;
    }
    case "create": {
      const name = await assertBranchName(cwd, req.name);
      const start = req.from ? [assertRevision(req.from, "start point")] : [];
      await git(cwd, ["checkout", "-b", name, ...start]);
      return;
    }
    case "rename": {
      const name = assertRevision(req.name, "branch");
      const next = await assertBranchName(cwd, String(req.newName ?? ""));
      await git(cwd, ["branch", "-m", name, next]);
      return;
    }
    case "delete": {
      const name = assertRevision(req.name, "branch");
      const current = (await git(cwd, ["branch", "--show-current"])).trim();
      if (name === current) throw new Error("The checked-out branch cannot be deleted. Switch to another branch first.");
      await git(cwd, ["branch", "-D", name]);
      return;
    }
  }
}

// --- remotes ----------------------------------------------------------------

type TokenResolver = () => Promise<string | null>;
let resolveGithubToken: TokenResolver | null = null;

/** Lets sync fall back to the signed-in GitHub account when git has no credentials of its own. */
export function configureGitAuth(resolver: TokenResolver | null): void {
  resolveGithubToken = resolver;
}

const NETWORK_TIMEOUT_MS = 180_000;
/** Never wait on a prompt nobody can see, and keep git's messages in one language to read them. */
const NETWORK_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C", LANG: "C" };

export function isAuthFailure(message: string): boolean {
  return /authentication failed|could not read (username|password)|terminal prompts disabled|invalid username or password|permission to .* denied|requested url returned error: (401|403)|repository not found/i.test(
    message,
  );
}

async function githubRemoteUrl(cwd: string): Promise<string | null> {
  const upstream = await upstreamOf(cwd);
  const remote = upstream?.split("/")[0] ?? (await git(cwd, ["remote"])).split("\n").find(Boolean) ?? null;
  if (!remote) return null;
  const url = (await git(cwd, ["remote", "get-url", remote]).catch(() => "")).trim();
  return /^https:\/\/([^@/]+@)?github\.com\//i.test(url) ? url : null;
}

async function runNetwork(cwd: string, args: string[]): Promise<void> {
  try {
    await git(cwd, args, { env: NETWORK_ENV, timeout: NETWORK_TIMEOUT_MS });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAuthFailure(message) || !resolveGithubToken) throw error;
    const [token, url] = await Promise.all([resolveGithubToken().catch(() => null), githubRemoteUrl(cwd)]);
    if (!token || !url) throw error;
    // Environment config, not `-c`, so the token never shows up in a process listing.
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    await git(cwd, args, {
      timeout: NETWORK_TIMEOUT_MS,
      env: {
        ...NETWORK_ENV,
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
      },
    });
  }
}

export async function remoteAction(req: GitRemoteActionRequest): Promise<void> {
  const cwd = await toplevel(req.cwd);
  const remote = (await git(cwd, ["remote"])).split("\n").map((name) => name.trim()).find(Boolean);
  if (!remote) throw new Error("This repository has no remote configured.");
  const upstream = await upstreamOf(cwd);
  switch (req.action) {
    case "fetch":
      await runNetwork(cwd, ["fetch", "--prune", "--all"]);
      return;
    case "pull":
      if (!upstream) throw new Error("This branch has not been published, so there is nothing to pull.");
      await runNetwork(cwd, ["pull", "--no-rebase", "--no-edit"]);
      return;
    case "push":
      await runNetwork(cwd, upstream ? ["push"] : ["push", "--set-upstream", remote, "HEAD"]);
      return;
  }
}

