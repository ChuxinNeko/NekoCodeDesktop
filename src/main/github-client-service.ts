import type { GitHubCredentialStore } from "./github-credential-store";
import { githubErrorMessage } from "./pull-request-service";
import type {
  GitHubClientRequest,
  GitHubClientResult,
  GitHubClientResults,
  GitHubRepo,
  GitHubThread,
  GitHubComment,
  GitHubFileChange,
  GitHubCommit,
  GitHubRun,
  GitHubJob,
  GitHubEntry,
} from "../shared/github-client";

type Json = Record<string, unknown>;
const record = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(record) : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;
const url = (v: unknown) => {
  try {
    const u = new URL(str(v));
    return u.protocol === "https:" && u.hostname === "github.com" ? u.href : "";
  } catch {
    return "";
  }
};
const id = (v: unknown) => {
  if (!Number.isSafeInteger(v) || Number(v) < 1)
    throw new Error("Invalid GitHub identifier");
  return String(v);
};
function text(v: unknown, name: string, max = 65536, empty = false): string {
  if (
    typeof v !== "string" ||
    (!empty && !v.trim()) ||
    v.length > max ||
    v.includes("\0")
  )
    throw new Error(`Invalid ${name}`);
  return v;
}
function repoPath(repo: unknown): string {
  if (
    typeof repo !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    repo.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Repository must be owner/name");
  return `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
}
function filePath(path: unknown): string {
  const value = text(path, "file path", 2048, true);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Invalid repository file path");
  return value.split("/").map(encodeURIComponent).join("/");
}
function state(v: unknown): string {
  if (!["open", "closed", "all"].includes(String(v)))
    throw new Error("Invalid issue state");
  return String(v);
}
function projectRepo(r: Json): GitHubRepo {
  const permissions = record(r.permissions);
  return {
    fullName: str(r.full_name),
    description: str(r.description),
    private: r.private === true,
    archived: r.archived === true,
    url: url(r.html_url),
    defaultBranch: str(r.default_branch),
    language: str(r.language),
    stars: num(r.stargazers_count),
    forks: num(r.forks_count),
    openIssues: num(r.open_issues_count),
    updatedAt: str(r.pushed_at ?? r.updated_at),
    canPush: permissions.push === true || permissions.admin === true,
    canManage: permissions.admin === true || permissions.maintain === true,
    mergeMethods: (["merge", "squash", "rebase"] as const).filter(
      (m) =>
        r[m === "merge" ? "allow_merge_commit" : `allow_${m}_merge`] !== false,
    ),
  };
}
function thread(r: Json): GitHubThread {
  return {
    number: num(r.number),
    title: str(r.title),
    body: str(r.body),
    state:
      r.merged_at || record(r.pull_request).merged_at ? "merged" : str(r.state),
    author: str(record(r.user).login),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    url: url(r.html_url),
    comments: num(r.comments),
    labels: list(r.labels).map((l) => str(l.name)),
    draft: r.draft === true,
    head: str(record(r.head).ref),
    base: str(record(r.base).ref),
  };
}
function comment(r: Json): GitHubComment {
  return {
    id: num(r.id),
    author: str(record(r.user).login),
    body: str(r.body),
    createdAt: str(r.created_at),
    url: url(r.html_url),
    path: str(r.path) || undefined,
  };
}
function change(r: Json): GitHubFileChange {
  return {
    path: str(r.filename),
    status: str(r.status),
    additions: num(r.additions),
    deletions: num(r.deletions),
    patch: str(r.patch),
  };
}
function commit(r: Json): GitHubCommit {
  const c = record(r.commit);
  const a = record(c.author);
  return {
    sha: str(r.sha),
    message: str(c.message),
    author: str(record(r.author).login) || str(a.name),
    date: str(a.date),
    url: url(r.html_url),
  };
}
function run(r: Json): GitHubRun {
  return {
    id: num(r.id),
    title: str(r.display_title) || str(r.name),
    workflow: str(r.name),
    number: num(r.run_number),
    branch: str(r.head_branch),
    sha: str(r.head_sha),
    status: str(r.status),
    conclusion: str(r.conclusion),
    event: str(r.event),
    actor: str(record(r.actor).login),
    createdAt: str(r.created_at),
    url: url(r.html_url),
  };
}
function job(r: Json): GitHubJob {
  return {
    id: num(r.id),
    name: str(r.name),
    status: str(r.status),
    conclusion: str(r.conclusion),
    url: url(r.html_url),
    steps: list(r.steps).map((s) => ({
      number: num(s.number),
      name: str(s.name),
      status: str(s.status),
      conclusion: str(s.conclusion),
    })),
  };
}
function entry(r: Json): GitHubEntry {
  return {
    name: str(r.name),
    path: str(r.path),
    type: str(r.type),
    sha: str(r.sha),
    size: num(r.size),
    url: url(r.html_url),
  };
}

/** Explicit operations only: the renderer cannot choose an API host or supply credentials. */
export class GitHubClientService {
  constructor(
    private readonly auth: Pick<GitHubCredentialStore, "resolveToken">,
    private readonly options: {
      request?: typeof fetch;
      resolveRepository?: (cwd: string) => Promise<string | null>;
      timeoutMs?: number;
    } = {},
  ) {}

  private async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<{ body: unknown; next: boolean }> {
    const { token } = await this.auth.resolveToken();
    if (!token) throw new Error("请先在 设置 → GitHub 授权 中连接账号。");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (async () => {
      const response = await (this.options.request ?? fetch)(
        `https://api.github.com${path}`,
        {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "nekocode-desktop",
            "x-github-api-version": "2022-11-28",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("GitHub response too large");
          }
          chunks.push(part.value);
        }
      const content = Buffer.concat(chunks).toString("utf8");
      if (!response.ok) {
        const hint =
          response.status === 403
            ? " 请检查 GitHub App 对此仓库的 Issues、Pull requests、Contents 和 Actions 权限，或在设置中重新授权。"
            : "";
        throw new Error(
          (githubErrorMessage(response.status, content, true) + hint)
            .split(token)
            .join("[redacted]"),
        );
      }
      return {
        body: content ? (JSON.parse(content) as unknown) : null,
        next: /rel="next"/.test(response.headers.get("link") ?? ""),
      };
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("连接 GitHub 超时，请重试。"));
      }, this.options.timeoutMs ?? 20_000);
    });
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async execute<T extends GitHubClientRequest>(
    input: T,
  ): Promise<GitHubClientResult<T["action"]>> {
    if (!input || typeof input !== "object" || typeof input.action !== "string")
      throw new Error("Invalid GitHub operation");
    return (await this.executeValidated(input)) as GitHubClientResult<
      T["action"]
    >;
  }

  private async executeValidated(
    r: GitHubClientRequest,
  ): Promise<GitHubClientResults[keyof GitHubClientResults]> {
    const page = "page" in r && r.page !== undefined ? Number(id(r.page)) : 1;
    if (page > 100000) throw new Error("Invalid page");
    const q = new URLSearchParams({ per_page: "30", page: String(page) });
    const paged = async <T>(
      path: string,
      project: (v: Json) => T,
      key?: string,
    ) => {
      const result = await this.request(path);
      return {
        items: list(key ? record(result.body)[key] : result.body).map(project),
        page,
        hasNext: result.next,
      };
    };
    if (r.action === "workspaceRepository")
      return (
        this.options.resolveRepository?.(text(r.cwd, "workspace path", 4096)) ??
        null
      );
    if (r.action === "repositories") {
      const query = r.query?.trim();
      if (query) {
        q.set(
          "q",
          `${text(query, "repository query", 200)} in:name,description`,
        );
        q.set("sort", "updated");
        return paged(`/search/repositories?${q}`, projectRepo, "items");
      }
      q.set("sort", "pushed");
      q.set("affiliation", "owner,collaborator,organization_member");
      return paged(`/user/repos?${q}`, projectRepo);
    }
    const base = repoPath(r.repo);
    switch (r.action) {
      case "repository":
        return projectRepo(record((await this.request(base)).body));
      case "branches": {
        const branches: string[] = [];
        for (let p = 1; p <= 10; p++) {
          const result = await this.request(
            `${base}/branches?per_page=100&page=${p}`,
          );
          branches.push(...list(result.body).map((b) => str(b.name)));
          if (!result.next) break;
        }
        return branches;
      }
      case "issues":
      case "pulls": {
        const filter = state(r.state);
        if (r.query?.trim()) {
          q.set(
            "q",
            `repo:${r.repo} is:${r.action === "issues" ? "issue" : "pr"}${filter === "all" ? "" : ` is:${filter}`} ${text(r.query.trim(), "search query", 300)}`,
          );
          q.set("sort", "updated");
          return paged(`/search/issues?${q}`, thread, "items");
        }
        q.set("state", filter);
        q.set("sort", "updated");
        q.set("direction", "desc");
        const result = await paged(`${base}/${r.action}?${q}`, (v) => v);
        return {
          ...result,
          items: result.items
            .filter((v) => r.action !== "issues" || !v.pull_request)
            .map(thread),
        };
      }
      case "issue":
        return thread(
          record((await this.request(`${base}/issues/${id(r.number)}`)).body),
        );
      case "pull": {
        const value = record(
          (await this.request(`${base}/pulls/${id(r.number)}`)).body,
        );
        return {
          ...thread(value),
          headSha: str(record(value.head).sha),
          merged: value.merged === true,
          mergeable:
            typeof value.mergeable === "boolean" ? value.mergeable : null,
          mergeableState: str(value.mergeable_state),
          additions: num(value.additions),
          deletions: num(value.deletions),
          changedFiles: num(value.changed_files),
        };
      }
      case "comments":
        return paged(`${base}/issues/${id(r.number)}/comments?${q}`, comment);
      case "reviews":
        return paged(`${base}/pulls/${id(r.number)}/comments?${q}`, comment);
      case "pullFiles":
        return paged(`${base}/pulls/${id(r.number)}/files?${q}`, change);
      case "checks": {
        const sha = encodeURIComponent(text(r.sha, "commit ref", 256));
        const [checks, statuses] = await Promise.all([
          this.request(`${base}/commits/${sha}/check-runs?per_page=100`),
          this.request(`${base}/commits/${sha}/status?per_page=100`),
        ]);
        return [
          ...list(record(checks.body).check_runs).map((v) => ({
            name: str(v.name),
            status: str(v.status),
            conclusion: str(v.conclusion),
            url: url(v.html_url),
          })),
          ...list(record(statuses.body).statuses).map((v) => ({
            name: str(v.context),
            status: v.state === "pending" ? "in_progress" : "completed",
            conclusion: str(v.state),
            url: url(v.target_url),
          })),
        ];
      }
      case "comment":
        return comment(
          record(
            (
              await this.request(
                `${base}/issues/${id(r.number)}/comments`,
                "POST",
                { body: text(r.body, "comment") },
              )
            ).body,
          ),
        );
      case "issueCreate":
        return thread(
          record(
            (
              await this.request(`${base}/issues`, "POST", {
                title: text(r.title, "title", 256),
                body: text(r.body, "description", 65536, true),
              })
            ).body,
          ),
        );
      case "issueState": {
        if (r.state !== "open" && r.state !== "closed")
          throw new Error("Invalid issue state");
        return thread(
          record(
            (
              await this.request(`${base}/issues/${id(r.number)}`, "PATCH", {
                state: r.state,
              })
            ).body,
          ),
        );
      }
      case "pullCreate":
        return thread(
          record(
            (
              await this.request(`${base}/pulls`, "POST", {
                title: text(r.title, "title", 256),
                body: text(r.body, "description", 65536, true),
                head: text(r.head, "head branch", 256),
                base: text(r.base, "base branch", 256),
                draft: r.draft === true,
              })
            ).body,
          ),
        );
      case "merge": {
        if (
          !["merge", "squash", "rebase"].includes(r.method) ||
          !/^[a-f\d]{40}$/i.test(r.sha)
        )
          throw new Error("Invalid merge method or head SHA");
        const result = record(
          (
            await this.request(`${base}/pulls/${id(r.number)}/merge`, "PUT", {
              sha: r.sha,
              merge_method: r.method,
            })
          ).body,
        );
        if (result.merged !== true)
          throw new Error(
            str(result.message) || "GitHub did not merge this pull request",
          );
        return {
          merged: true,
          message: str(result.message),
          sha: str(result.sha),
        };
      }
      case "commits":
        if (r.ref) q.set("sha", text(r.ref, "branch", 256));
        return paged(`${base}/commits?${q}`, commit);
      case "commit": {
        const result = await this.request(
          `${base}/commits/${encodeURIComponent(text(r.sha, "commit", 256))}?${q}`,
        );
        return {
          ...commit(record(result.body)),
          files: {
            items: list(record(result.body).files).map(change),
            page,
            hasNext: result.next,
          },
        };
      }
      case "contents": {
        const path = filePath(r.path);
        q.set("ref", text(r.ref, "branch", 256));
        const result = (await this.request(`${base}/contents/${path}?${q}`))
          .body;
        if (Array.isArray(result))
          return { entries: list(result).map(entry), file: null };
        const value = record(result);
        const bytes = Buffer.from(
          str(value.content).replace(/\n/g, ""),
          "base64",
        );
        const decoded = bytes.toString("utf8");
        const editable =
          value.type === "file" &&
          value.encoding === "base64" &&
          num(value.size) <= 512 * 1024 &&
          !decoded.includes("\0") &&
          !decoded.includes("\ufffd");
        return {
          entries: [],
          file: {
            ...entry(value),
            text: editable ? decoded : "",
            editable,
            notice: editable
              ? ""
              : "文件为二进制、特殊文件或超过 512 KB，请在 GitHub 中查看。",
          },
        };
      }
      case "saveFile": {
        const path = filePath(r.path);
        if (!path || !/^[a-f\d]{40}$/i.test(r.sha))
          throw new Error("Invalid file path or blob SHA");
        const content = Buffer.from(
          text(r.text, "file content", 512 * 1024, true),
          "utf8",
        );
        if (content.byteLength > 512 * 1024)
          throw new Error("File exceeds 512 KB");
        const result = record(
          (
            await this.request(`${base}/contents/${path}`, "PUT", {
              branch: text(r.branch, "branch", 256),
              sha: r.sha,
              content: content.toString("base64"),
              message: text(r.message, "commit message", 4096),
            })
          ).body,
        );
        return {
          sha: str(record(result.commit).sha),
          url: url(record(result.commit).html_url),
        };
      }
      case "workflows":
        return paged(
          `${base}/actions/workflows?${q}`,
          (v) => ({
            id: num(v.id),
            name: str(v.name),
            path: str(v.path),
            state: str(v.state),
            url: url(v.html_url),
          }),
          "workflows",
        );
      case "runs": {
        if (r.branch) q.set("branch", text(r.branch, "branch", 256));
        if (r.status) {
          if (
            ![
              "queued",
              "in_progress",
              "completed",
              "success",
              "failure",
              "cancelled",
              "waiting",
              "action_required",
            ].includes(r.status)
          )
            throw new Error("Invalid run status");
          q.set("status", r.status);
        }
        return paged(
          `${base}/actions/${r.workflow ? `workflows/${id(r.workflow)}/runs` : "runs"}?${q}`,
          run,
          "workflow_runs",
        );
      }
      case "jobs":
        return paged(
          `${base}/actions/runs/${id(r.run)}/jobs?${q}`,
          job,
          "jobs",
        );
      case "artifacts":
        return paged(
          `${base}/actions/runs/${id(r.run)}/artifacts?${q}`,
          (v) => ({
            id: num(v.id),
            name: str(v.name),
            size: num(v.size_in_bytes),
            expired: v.expired === true,
            url: `https://github.com/${r.repo}/actions/runs/${r.run}/artifacts/${num(v.id)}`,
          }),
          "artifacts",
        );
      case "runAction": {
        if (!["rerun", "rerun-failed-jobs", "cancel"].includes(r.operation))
          throw new Error("Invalid workflow operation");
        await this.request(
          `${base}/actions/runs/${id(r.run)}/${r.operation}`,
          "POST",
        );
        return { ok: true };
      }
      case "dispatch": {
        if (
          !r.inputs ||
          typeof r.inputs !== "object" ||
          Array.isArray(r.inputs) ||
          Object.keys(r.inputs).length > 25 ||
          Object.values(r.inputs).some((v) => typeof v !== "string")
        )
          throw new Error("Workflow inputs must be a JSON object of strings");
        await this.request(
          `${base}/actions/workflows/${id(r.workflow)}/dispatches`,
          "POST",
          { ref: text(r.ref, "branch", 256), inputs: r.inputs },
        );
        return { ok: true };
      }
      case "jobLog":
        return this.jobLog(base, Number(id(r.job)));
      default:
        throw new Error("Unsupported GitHub operation");
    }
  }

  private async jobLog(
    base: string,
    jobId: number,
  ): Promise<{ text: string; truncated: boolean }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("读取 GitHub 日志超时，请重试。"));
      }, this.options.timeoutMs ?? 20_000);
    });
    try {
      return await Promise.race([
        this.readJobLog(base, jobId, controller.signal),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJobLog(
    base: string,
    jobId: number,
    signal: AbortSignal,
  ): Promise<{ text: string; truncated: boolean }> {
    const { token } = await this.auth.resolveToken();
    if (!token) throw new Error("请先连接 GitHub 账号。");
    const request = this.options.request ?? fetch;
    const response = await request(
      `https://api.github.com${base}/actions/jobs/${jobId}/logs`,
      {
        redirect: "manual",
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": "nekocode-desktop",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    const location = response.headers.get("location");
    let logResponse = response;
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      const target = new URL(location);
      if (
        target.protocol !== "https:" ||
        ![
          ".githubusercontent.com",
          ".blob.core.windows.net",
          ".github.com",
        ].some((host) => target.hostname.endsWith(host))
      )
        throw new Error("GitHub returned an unsupported log destination");
      // The signed log URL needs no GitHub token; do not forward authorization.
      logResponse = await request(target.href, { redirect: "error", signal });
    }
    if (!logResponse.ok) {
      await logResponse.body?.cancel();
      throw new Error(
        `无法读取日志（HTTP ${logResponse.status}）。任务运行中或日志已过期时可能不可用。`,
      );
    }
    const reader = logResponse.body?.getReader();
    let tail = "";
    let total = 0;
    let truncated = false;
    const decoder = new TextDecoder();
    if (reader)
      for (;;) {
        const part = await reader.read();
        if (part.done) {
          tail += decoder.decode();
          break;
        }
        total += part.value.byteLength;
        tail += decoder.decode(part.value, { stream: true });
        if (tail.length > 128000) {
          tail = tail.slice(-128000);
          truncated = true;
        }
        if (total > 8 * 1024 * 1024) {
          await reader.cancel();
          truncated = true;
          break;
        }
      }
    return { text: tail.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""), truncated };
  }
}
