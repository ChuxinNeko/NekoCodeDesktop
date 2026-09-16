export type ReviewScope = "unstaged" | "staged" | "branch" | "lastturn";

export type GitActionKind = "stage" | "unstage" | "revert";

export interface ChangedFile {
  path: string;
  /** X+Y status from git status --porcelain, e.g. "M ", " M", "??" */
  status: string;
  staged: boolean;
  untracked: boolean;
  additions: number;
  deletions: number;
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
}

export interface GitDiffRequest {
  cwd: string;
  scope: ReviewScope;
  file?: string;
}

export interface GitActionRequest {
  cwd: string;
  action: GitActionKind;
  /** undefined = apply to all files in scope */
  file?: string;
}
