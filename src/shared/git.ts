export type ReviewScope = "unstaged" | "staged" | "branch" | "lastturn" | "head";

export type GitActionKind = "stage" | "unstage" | "revert";

export interface ChangedFile {
  path: string;
  /** X+Y status from git status --porcelain, e.g. "M ", " M", "??" */
  status: string;
  staged: boolean;
  untracked: boolean;
  additions: number;
  deletions: number;
  /** Set for renames and copies: the path the file had before. */
  oldPath?: string;
}

export interface RepoStatus {
  isRepo: boolean;
  /**
   * False when the `git` executable itself could not be spawned. Distinct from
   * `isRepo: false`, which means git ran and reported a non-repository: the UI
   * can offer `git init` in the second case and only an install hint in the first.
   */
  gitAvailable: boolean;
  branch: string | null;
  baseBranch: string | null;
  files: ChangedFile[];
  /** Populated when git could not be run, so the UI can show why. */
  gitError?: string;
  /** Short name of the repository folder. */
  repoName?: string;
  /** False for a fresh `git init`: there is no HEAD to diff or undo against. */
  hasCommits?: boolean;
  /** The remote-tracking branch, such as `origin/main`; null when not published. */
  upstream?: string | null;
  /** First configured remote name, used to publish a new branch. */
  remote?: string | null;
  ahead?: number;
  behind?: number;
  /** A merge is half-done (MERGE_HEAD exists), usually because of conflicts. */
  merging?: boolean;
  /** Abbreviated HEAD when the checkout is detached. */
  detachedAt?: string | null;
  lastCommit?: GitCommitSummary | null;
  /** More files changed than the list carries. */
  truncated?: boolean;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  subject: string;
  /** False when the commit is not yet on the upstream branch. */
  pushed: boolean;
}

export interface GitDiffRequest {
  cwd: string;
  scope: ReviewScope;
  file?: string;
  /** With a rename, the previous path, so git can pair the two sides. */
  oldPath?: string;
  ignoreWhitespace?: boolean;
}

export interface GitActionRequest {
  cwd: string;
  action: GitActionKind;
  /** undefined = apply to all files in scope */
  file?: string;
}

/** A single file's change inside a commit or between two revisions. */
export interface GitFileChange {
  path: string;
  oldPath?: string;
  /** A, M, D, R, C or T — the first letter of `git diff --name-status`. */
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  /** Strict ISO 8601 author date. */
  date: string;
  subject: string;
  /** Decorations such as `HEAD -> main`, `origin/main`, `tag: v1`. */
  refs: string[];
  /** Only known when the branch has an upstream to compare against. */
  unpushed: boolean;
}

export interface GitLogRequest {
  cwd: string;
  limit?: number;
  skip?: number;
  /** Case-insensitive text matched against subject, body and author. */
  search?: string;
  /** Limit to commits reachable from HEAD but not from this revision. */
  since?: string;
}

export interface GitLogResult {
  commits: GitCommit[];
  hasMore: boolean;
}

export interface GitCommitDetail {
  commit: GitCommit;
  body: string;
  files: GitFileChange[];
}

export interface GitRangeRequest {
  cwd: string;
  /** null diffs against the empty tree, which is how a root commit is shown. */
  from: string | null;
  to: string;
}

export interface GitRangeDiffRequest extends GitRangeRequest {
  file: string;
  oldPath?: string;
  ignoreWhitespace?: boolean;
}

export interface GitCompareInfo {
  /** Branch the current one is compared with, such as `origin/main`. */
  base: string | null;
  mergeBase: string | null;
  ahead: number;
  behind: number;
}

export interface GitBranch {
  name: string;
  isRemote: boolean;
  current: boolean;
  upstream: string | null;
  /** ISO committer date of the tip. */
  date: string | null;
}

export interface GitBranchList {
  current: string | null;
  branches: GitBranch[];
}

export type GitBranchActionKind = "switch" | "create" | "delete" | "rename";

export interface GitBranchActionRequest {
  cwd: string;
  action: GitBranchActionKind;
  name: string;
  /** create: start point, a commit or branch; defaults to HEAD. */
  from?: string;
  /** rename: the new name. */
  newName?: string;
}

export type GitRemoteActionKind = "fetch" | "pull" | "push";

export interface GitRemoteActionRequest {
  cwd: string;
  action: GitRemoteActionKind;
}

export interface GitCommitRequest {
  cwd: string;
  summary: string;
  description?: string;
  /**
   * Paths to commit. Omit to commit every change. Anything left out stays in
   * the working tree exactly as it was.
   */
  files?: string[];
  amend?: boolean;
}

export interface GitCommitResult {
  hash: string;
  shortHash: string;
}

export interface GitDiscardRequest {
  cwd: string;
  /** Omit to discard every change, including untracked files. */
  files?: string[];
}

export interface GitUndoCommitResult {
  summary: string;
  description: string;
}

export type GitHistoryAction = "revert";
