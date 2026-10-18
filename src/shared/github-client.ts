/** GitHub workbench contracts. Authentication stays in the desktop process. */
export interface GitHubPage<T> {
  items: T[];
  page: number;
  hasNext: boolean;
}
export interface GitHubRepo {
  fullName: string;
  description: string;
  private: boolean;
  archived: boolean;
  url: string;
  defaultBranch: string;
  language: string;
  stars: number;
  forks: number;
  openIssues: number;
  updatedAt: string;
  canPush: boolean;
  canManage: boolean;
  mergeMethods: Array<"merge" | "squash" | "rebase">;
}
export interface GitHubThread {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  comments: number;
  labels: string[];
  draft: boolean;
  head: string;
  base: string;
}
export interface GitHubComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
  path?: string;
}
export interface GitHubFileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}
export interface GitHubPull extends GitHubThread {
  headSha: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}
export interface GitHubCheck {
  name: string;
  status: string;
  conclusion: string;
  url: string;
}
export interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}
export interface GitHubCommitDetail extends GitHubCommit {
  files: GitHubPage<GitHubFileChange>;
}
export interface GitHubEntry {
  name: string;
  path: string;
  type: string;
  sha: string;
  size: number;
  url: string;
}
export interface GitHubContents {
  entries: GitHubEntry[];
  file:
    | (GitHubEntry & { text: string; editable: boolean; notice: string })
    | null;
}
export interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  url: string;
}
export interface GitHubRun {
  id: number;
  title: string;
  workflow: string;
  number: number;
  branch: string;
  sha: string;
  status: string;
  conclusion: string;
  event: string;
  actor: string;
  createdAt: string;
  url: string;
}
export interface GitHubJob {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  url: string;
  steps: Array<{
    number: number;
    name: string;
    status: string;
    conclusion: string;
  }>;
}
export interface GitHubArtifact {
  id: number;
  name: string;
  size: number;
  expired: boolean;
  url: string;
}

type RepoRequest = { repo: string };
type PageRequest = { page?: number };
export type GitHubClientRequest =
  | ({ action: "repositories"; query?: string } & PageRequest)
  | { action: "workspaceRepository"; cwd: string }
  | ({ action: "repository" | "branches" } & RepoRequest)
  | ({
      action: "issues" | "pulls";
      state: "open" | "closed" | "all";
      query?: string;
    } & RepoRequest &
      PageRequest)
  | ({ action: "issue" | "pull"; number: number } & RepoRequest)
  | ({
      action: "comments" | "reviews" | "pullFiles";
      number: number;
    } & RepoRequest &
      PageRequest)
  | ({ action: "checks"; sha: string } & RepoRequest)
  | ({ action: "comment"; number: number; body: string } & RepoRequest)
  | ({ action: "issueCreate"; title: string; body: string } & RepoRequest)
  | ({
      action: "issueState";
      number: number;
      state: "open" | "closed";
    } & RepoRequest)
  | ({
      action: "pullCreate";
      title: string;
      body: string;
      head: string;
      base: string;
      draft: boolean;
    } & RepoRequest)
  | ({
      action: "merge";
      number: number;
      sha: string;
      method: "merge" | "squash" | "rebase";
    } & RepoRequest)
  | ({ action: "commits"; ref?: string } & RepoRequest & PageRequest)
  | ({ action: "commit"; sha: string } & RepoRequest & PageRequest)
  | ({ action: "contents"; path: string; ref: string } & RepoRequest)
  | ({
      action: "saveFile";
      path: string;
      branch: string;
      sha: string;
      text: string;
      message: string;
    } & RepoRequest)
  | ({ action: "workflows" } & RepoRequest & PageRequest)
  | ({
      action: "runs";
      workflow?: number;
      branch?: string;
      status?: string;
    } & RepoRequest &
      PageRequest)
  | ({ action: "jobs" | "artifacts"; run: number } & RepoRequest & PageRequest)
  | ({ action: "jobLog"; job: number } & RepoRequest)
  | ({
      action: "runAction";
      run: number;
      operation: "rerun" | "rerun-failed-jobs" | "cancel";
    } & RepoRequest)
  | ({
      action: "dispatch";
      workflow: number;
      ref: string;
      inputs: Record<string, string>;
    } & RepoRequest);

export interface GitHubClientResults {
  repositories: GitHubPage<GitHubRepo>;
  workspaceRepository: string | null;
  repository: GitHubRepo;
  branches: string[];
  issues: GitHubPage<GitHubThread>;
  pulls: GitHubPage<GitHubThread>;
  issue: GitHubThread;
  pull: GitHubPull;
  comments: GitHubPage<GitHubComment>;
  reviews: GitHubPage<GitHubComment>;
  pullFiles: GitHubPage<GitHubFileChange>;
  checks: GitHubCheck[];
  comment: GitHubComment;
  issueCreate: GitHubThread;
  issueState: GitHubThread;
  pullCreate: GitHubThread;
  merge: { merged: boolean; message: string; sha: string };
  commits: GitHubPage<GitHubCommit>;
  commit: GitHubCommitDetail;
  contents: GitHubContents;
  saveFile: { sha: string; url: string };
  workflows: GitHubPage<GitHubWorkflow>;
  runs: GitHubPage<GitHubRun>;
  jobs: GitHubPage<GitHubJob>;
  artifacts: GitHubPage<GitHubArtifact>;
  jobLog: { text: string; truncated: boolean };
  runAction: { ok: true };
  dispatch: { ok: true };
}
export type GitHubClientResult<T extends GitHubClientRequest["action"]> =
  GitHubClientResults[T];
