import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	CheckRollup,
	CheckState,
	CreatePullRequestRequest,
	PullRequestComment,
	PullRequestDetail,
	PullRequestFilter,
	PullRequestListResult,
	PullRequestState,
	PullRequestSummary,
	RepositoryBranch,
	RepositoryIdentity,
} from "../shared/pullRequests";
import type { GitHubAuthService } from "./github-auth";

const execFileP = promisify(execFile);

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PER_PAGE = 50;

/**
 * Pull requests are read straight from the GitHub REST API rather than shelling out
 * to `gh`, so the panel works on a machine that has never installed the CLI.
 * Authentication is optional: public repositories are readable anonymously, and the
 * service falls back to `gh auth token` when a saved token is absent.
 */
export class PullRequestService {
	private readonly auth: GitHubAuthService;

	constructor(auth: GitHubAuthService) {
		this.auth = auth;
	}

	// ─── Repository resolution ───────────────────────────────────────────────

	/**
	 * Resolve the GitHub repository from the project's git remotes. `origin` wins;
	 * otherwise the first remote that points at a GitHub host is used.
	 *
	 * Reads the raw configured URLs from `git config` rather than `git remote -v`:
	 * `-v` prints the URL *after* `url.<base>.insteadOf` rewrites, so a machine with
	 * a mirror configured (common behind corporate proxies and in CN networks) would
	 * report the mirror host and look like a non-GitHub remote.
	 */
	async resolveRepository(cwd: string): Promise<RepositoryIdentity | null> {
		let config: string;
		try {
			config = (
				await execFileP("git", ["config", "--get-regexp", String.raw`^remote\..*\.url$`], {
					cwd,
					timeout: 10_000,
				})
			).stdout;
		} catch {
			return null;
		}
		const byName = new Map<string, string>();
		for (const line of config.split("\n")) {
			const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
			if (!match) continue;
			const [, name, url] = match;
			if (name && url && !byName.has(name)) byName.set(name, url.trim());
		}
		const ordered = [
			...(byName.has("origin") ? [byName.get("origin")!] : []),
			...[...byName.entries()].filter(([name]) => name !== "origin").map(([, url]) => url),
		];
		for (const url of ordered) {
			const identity = parseRemoteUrl(url);
			if (identity) return identity;
		}
		return null;
	}

	// ─── API plumbing ────────────────────────────────────────────────────────

	private async request(
		path: string,
		init?: { method?: string; body?: unknown },
	): Promise<unknown> {
		const { token } = await this.auth.resolveToken();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(`https://api.github.com${path}`, {
				method: init?.method ?? "GET",
				headers: {
					accept: "application/vnd.github+json",
					"x-github-api-version": "2022-11-28",
					"user-agent": "nekocode-desktop",
					...(token ? { authorization: `Bearer ${token}` } : {}),
					...(init?.body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				signal: controller.signal,
			});
			const text = await response.text();
			if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
				throw new Error("GitHub response too large");
			}
			if (!response.ok) {
				throw new Error(githubErrorMessage(response.status, text, token !== null));
			}
			return text.length === 0 ? null : JSON.parse(text);
		} finally {
			clearTimeout(timer);
		}
	}

	async list(
		cwd: string,
		filter: PullRequestFilter = "open",
	): Promise<PullRequestListResult> {
		const repository = await this.resolveRepository(cwd);
		if (!repository) return { repository: null, pullRequests: [] };
		const { owner, repo } = repository;
		const raw = (await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls` +
				`?state=${filter}&per_page=${String(PER_PAGE)}&sort=updated&direction=desc`,
		)) as unknown;
		if (!Array.isArray(raw)) return { repository, pullRequests: [] };
		// One request for the whole list: diff stats and check runs are not in this
		// payload, and fetching them per row would blow the anonymous rate limit.
		return {
			repository,
			pullRequests: raw.filter(isRecord).map((entry) => toSummary(entry)),
		};
	}

	async detail(cwd: string, number: number): Promise<PullRequestDetail> {
		const repository = await this.resolveRepository(cwd);
		if (!repository) throw new Error("No GitHub remote found for this project");
		const base = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
		const pull = (await this.request(`${base}/pulls/${String(number)}`)) as unknown;
		if (!isRecord(pull)) throw new Error(`Pull request #${String(number)} not found`);
		const summary = toSummary(pull);
		const headSha =
			isRecord(pull.head) && typeof pull.head.sha === "string" ? pull.head.sha : null;

		// Each of these is best-effort: a token without the right scopes still gets
		// the pull request itself, and the panel shows whatever came back.
		const [issueComments, reviewComments, checkRuns] = await Promise.all([
			this.safeArray(`${base}/issues/${String(number)}/comments?per_page=50`),
			this.safeArray(`${base}/pulls/${String(number)}/comments?per_page=50`),
			headSha === null
				? Promise.resolve(null)
				: this.safeValue(`${base}/commits/${headSha}/check-runs?per_page=100`),
		]);
		const runs =
			isRecord(checkRuns) && Array.isArray(checkRuns.check_runs)
				? checkRuns.check_runs
				: Array.isArray(checkRuns)
					? checkRuns
					: [];

		return {
			...summary,
			checks: rollupChecks(runs.filter(isRecord)),
			body: typeof pull.body === "string" ? pull.body : "",
			mergeable: typeof pull.mergeable === "boolean" ? pull.mergeable : null,
			merged: pull.merged === true,
			checkRuns: runs.filter(isRecord).map((run) => ({
				name: typeof run.name === "string" ? run.name : "check",
				state: mapCheckState(run.status, run.conclusion),
				...(typeof run.html_url === "string" ? { url: run.html_url } : {}),
			})),
			issueComments: issueComments.filter(isRecord).map(toComment),
			reviewComments: reviewComments.filter(isRecord).map(toReviewComment),
		};
	}

	async branches(cwd: string): Promise<RepositoryBranch[]> {
		try {
			const [names, current] = await Promise.all([
				execFileP("git", ["branch", "--format=%(refname:short)"], { cwd, timeout: 10_000 }),
				execFileP("git", ["branch", "--show-current"], { cwd, timeout: 10_000 }),
			]);
			const currentName = current.stdout.trim();
			return names.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((name) => ({ name, isCurrent: name === currentName }));
		} catch {
			return [];
		}
	}

	async create(request: CreatePullRequestRequest): Promise<PullRequestSummary> {
		const repository = await this.resolveRepository(request.cwd);
		if (!repository) throw new Error("No GitHub remote found for this project");
		const created = (await this.request(
			`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls`,
			{
				method: "POST",
				body: {
					title: request.title,
					body: request.body,
					base: request.base,
					head: request.head,
					draft: request.draft,
				},
			},
		)) as unknown;
		if (!isRecord(created)) throw new Error("GitHub did not return the created pull request");
		return toSummary(created);
	}

	/** Best-effort read: a scope-limited token still returns the pull request itself. */
	private async safeArray(path: string): Promise<unknown[]> {
		try {
			const result = await this.request(path);
			return Array.isArray(result) ? result : [];
		} catch {
			return [];
		}
	}

	private async safeValue(path: string): Promise<unknown> {
		try {
			return await this.request(path);
		} catch {
			return null;
		}
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Project a GitHub pull-request payload into the panel's summary shape. Reads only
 * what the payload already contains: the list endpoint omits diff stats and checks,
 * so those stay zero there and are filled in by `detail()`.
 */
export function toSummary(pull: Record<string, unknown>): PullRequestSummary {
	const number = typeof pull.number === "number" ? pull.number : 0;
	const user = isRecord(pull.user) ? pull.user : {};
	const head = isRecord(pull.head) ? pull.head : {};
	const baseRef = isRecord(pull.base) ? pull.base : {};
	return {
		number,
		title: typeof pull.title === "string" ? pull.title : `#${String(number)}`,
		state: mapPullRequestState(pull),
		draft: pull.draft === true,
		author: typeof user.login === "string" ? user.login : "unknown",
		...(typeof user.avatar_url === "string" ? { authorAvatarUrl: user.avatar_url } : {}),
		headRef: typeof head.ref === "string" ? head.ref : "",
		baseRef: typeof baseRef.ref === "string" ? baseRef.ref : "",
		createdAt: typeof pull.created_at === "string" ? pull.created_at : "",
		updatedAt: typeof pull.updated_at === "string" ? pull.updated_at : "",
		url: typeof pull.html_url === "string" ? pull.html_url : "",
		additions: number0(pull.additions),
		deletions: number0(pull.deletions),
		changedFiles: number0(pull.changed_files),
		comments: number0(pull.comments),
		checks: { success: 0, failure: 0, pending: 0, total: 0 },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number0(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Parse a git remote URL into a GitHub repository identity. Supports
 * `git@host:owner/repo.git`, `https://host/owner/repo.git`, and `ssh://` forms.
 *
 * Only github.com is accepted. A GitHub Enterprise host is not distinguishable
 * from GitLab/Gitea by URL shape alone, and it would need its own API base and
 * its own token, so it is rejected here rather than half-supported: the panel
 * then reports "no GitHub remote" instead of failing at the API with a confusing
 * 404.
 */
export function parseRemoteUrl(url: string): RepositoryIdentity | null {
	const trimmed = url.trim();
	let host: string;
	let path: string;

	const scpLike = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
	if (scpLike && !trimmed.includes("://")) {
		host = scpLike[1] ?? "";
		path = scpLike[2] ?? "";
	} else {
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			return null;
		}
		host = parsed.hostname;
		path = parsed.pathname;
	}

	if (host !== "github.com") return null;
	const segments = path
		.replace(/^\/+/, "")
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	if (segments.length < 2) return null;
	const [owner, repo] = segments;
	if (!owner || !repo) return null;
	return { owner, repo, host };
}

function mapPullRequestState(pull: Record<string, unknown>): PullRequestState {
	if (pull.draft === true) return "draft";
	if (typeof pull.merged_at === "string" && pull.merged_at.length > 0) return "merged";
	return pull.state === "closed" ? "closed" : "open";
}

function mapCheckState(status: unknown, conclusion: unknown): CheckState {
	if (status !== "completed") return "pending";
	switch (conclusion) {
		case "success":
			return "success";
		case "failure":
		case "timed_out":
		case "action_required":
		case "startup_failure":
			return "failure";
		case "skipped":
			return "skipped";
		default:
			return "neutral";
	}
}

function rollupChecks(runs: Record<string, unknown>[]): CheckRollup {
	let success = 0;
	let failure = 0;
	let pending = 0;
	for (const run of runs) {
		const state = mapCheckState(run.status, run.conclusion);
		if (state === "success") success += 1;
		else if (state === "failure") failure += 1;
		else if (state === "pending") pending += 1;
	}
	return { success, failure, pending, total: runs.length };
}

function toComment(raw: Record<string, unknown>): PullRequestComment {
	const user = isRecord(raw.user) ? raw.user : {};
	return {
		id: number0(raw.id),
		author: typeof user.login === "string" ? user.login : "unknown",
		...(typeof user.avatar_url === "string" ? { authorAvatarUrl: user.avatar_url } : {}),
		body: typeof raw.body === "string" ? raw.body : "",
		createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
		url: typeof raw.html_url === "string" ? raw.html_url : "",
	};
}

function toReviewComment(raw: Record<string, unknown>): PullRequestComment {
	const comment = toComment(raw);
	return {
		...comment,
		...(typeof raw.path === "string" ? { path: raw.path } : {}),
		...(typeof raw.line === "number"
			? { line: raw.line }
			: typeof raw.original_line === "number"
				? { line: raw.original_line }
				: {}),
	};
}

/**
 * Turn an API failure into something the panel can act on. The anonymous
 * rate limit and missing-token cases are the ones users actually hit.
 */
export function githubErrorMessage(status: number, body: string, authenticated: boolean): string {
	if (status === 401) return "GitHub 拒绝了该 token（401）。请在 Settings → GitHub 重新填写。";
	if (status === 404) {
		return authenticated
			? "仓库或 PR 不存在，或 token 无权访问（404）。"
			: "仓库不存在，或是私有仓库（需要 token）。";
	}
	if (status === 403 || status === 429) {
		return authenticated
			? "GitHub 限流或权限不足（403/429）。"
			: "已达到 GitHub 匿名限流（60 次/小时）。在 Settings → GitHub 填 token 可提高额度。";
	}
	let detail = "";
	try {
		const parsed = JSON.parse(body) as { message?: unknown };
		if (typeof parsed.message === "string") detail = parsed.message;
	} catch {
		detail = body.slice(0, 200);
	}
	return `GitHub API 失败 (HTTP ${String(status)})${detail ? `: ${detail}` : ""}`;
}
