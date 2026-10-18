import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { RepositoryIdentity } from "../shared/pullRequests";
import type { GitHubAuthService } from "./github-auth";
import { githubErrorMessage, PullRequestService } from "./pull-request-service";

/**
 * GitHub, read-only, for the agent: repositories, issues, pull requests and
 * their diffs, CI checks and Actions logs, files, search.
 *
 * Straight to the REST API with the token the GitHub settings page resolves
 * (saved token, then `gh auth token`, then anonymous), the same way the pull
 * request panel works — so it needs no `gh` install. Read-only on purpose: it
 * is offered in the read-only modes too, and opening a PR or commenting is a
 * thing the user does from the panel, not something to happen mid-turn.
 */

export const GITHUB_TOOL_NAME = "github";

let authSource: () => GitHubAuthService | null = () => null;

export function configureGithubTool(source: () => GitHubAuthService | null): void {
	authSource = source;
}

const API = "https://api.github.com";
const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Characters of a diff, log or file per call; the rest is paged with `offset`. */
const PAGE_CHARS = 30_000;
const LOG_TAIL_LINES = 200;
const MAX_TEXT = 4000;

type Json = Record<string, unknown>;

function record(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function list(value: unknown): Json[] {
	return Array.isArray(value) ? value.map(record) : [];
}

function str(value: unknown): string {
	return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function clip(text: string, max = MAX_TEXT): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}\n…(${trimmed.length - max} more characters)` : trimmed;
}

function login(value: unknown): string {
	return str(record(value).login) || "unknown";
}

function day(value: unknown): string {
	return str(value).slice(0, 10);
}

/** One page of a long text, with the footer that says how to get the next. */
function page(text: string, offset: number): string {
	const start = Math.min(offset, text.length);
	const end = Math.min(start + PAGE_CHARS, text.length);
	const body = text.slice(start, end);
	return start > 0 || end < text.length
		? `${body}\n\n[Characters ${start}–${end} of ${text.length}.${end < text.length ? ` Pass offset=${end} to read on.` : ""}]`
		: body;
}

class GitHubClient {
	constructor(
		private readonly auth: GitHubAuthService,
		private readonly signal: AbortSignal | undefined,
	) {}

	async raw(path: string, accept: string): Promise<Response & { authenticated: boolean }> {
		const { token } = await this.auth.resolveToken();
		const timeout = AbortSignal.timeout(TIMEOUT_MS);
		const response = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
			headers: {
				accept,
				"x-github-api-version": "2022-11-28",
				"user-agent": "nekocode-desktop",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			redirect: "follow",
			signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
		});
		return Object.assign(response, { authenticated: token !== null });
	}

	async text(path: string, accept = "application/vnd.github+json"): Promise<string> {
		const response = await this.raw(path, accept);
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new Error("GitHub response too large");
		if (!response.ok) throw new Error(githubErrorMessage(response.status, text, response.authenticated));
		return text;
	}

	async json(path: string): Promise<unknown> {
		const text = await this.text(path);
		return text ? JSON.parse(text) : null;
	}
}

/** `owner/repo`, or the current checkout's GitHub remote. */
async function resolveRepo(auth: GitHubAuthService, cwd: string, repo: string | undefined): Promise<RepositoryIdentity> {
	if (repo?.trim()) {
		const match = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repo.trim());
		if (!match) throw new Error(`repo must be owner/repo, not ${repo}`);
		return { owner: match[1], repo: match[2], host: "github.com" };
	}
	const identity = await new PullRequestService(auth).resolveRepository(cwd);
	if (!identity) throw new Error("This workspace has no github.com remote; pass repo as owner/repo.");
	return identity;
}

function repoPath(identity: RepositoryIdentity): string {
	return `/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}`;
}

const OPS = ["repo_view", "issue_view", "pr_view", "pr_diff", "pr_checks", "runs", "run_view", "file_read", "search"] as const;
type Op = (typeof OPS)[number];
const SEARCH_KINDS = ["issues", "prs", "code", "repos", "commits"] as const;

const schema = Type.Object(
	{
		op: Type.Union(OPS.map((op) => Type.Literal(op)), {
			description:
				"repo_view: repository overview. issue_view / pr_view: one issue or PR with its discussion (pr_view adds changed files). pr_diff: the PR's unified diff, optionally one file. pr_checks: CI checks and statuses for a PR (or ref). runs: recent Actions workflow runs. run_view: one run's jobs and, for failed jobs, the tail of their logs. file_read: a file from the repository at a ref. search: issues, prs, code, repos or commits.",
		}),
		repo: Type.Optional(Type.String({ description: "owner/repo. Defaults to this workspace's github.com remote." })),
		number: Type.Optional(Type.Integer({ minimum: 1, description: "Issue or PR number (issue_view, pr_view, pr_diff, pr_checks)." })),
		ref: Type.Optional(Type.String({ description: "Branch, tag or commit SHA (pr_checks without number, file_read; runs filters by branch)." })),
		path: Type.Optional(Type.String({ description: "File path (file_read; pr_diff to show one file)." })),
		run: Type.Optional(Type.Integer({ minimum: 1, description: "Workflow run id (run_view)." })),
		kind: Type.Optional(
			Type.Union(SEARCH_KINDS.map((kind) => Type.Literal(kind)), { description: "What to search (search)." }),
		),
		query: Type.Optional(Type.String({ description: "GitHub search syntax (search). Scoped to repo unless the query has repo:/org:/user:." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Items to list (search, runs). Defaults to 10." })),
		offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset to read on in a long pr_diff or file_read." })),
	},
	{ additionalProperties: false },
);

type Input = Static<typeof schema>;

function need<T>(value: T | undefined, name: string, op: Op): T {
	if (value === undefined || value === null || value === "") throw new Error(`${op} needs ${name}`);
	return value;
}

async function repoView(gh: GitHubClient, id: RepositoryIdentity): Promise<string> {
	const data = record(await gh.json(repoPath(id)));
	const topics = Array.isArray(data.topics) ? data.topics.join(", ") : "";
	return [
		`${str(data.full_name)}${data.private ? " (private)" : ""}${data.archived ? " (archived)" : ""}`,
		str(data.description),
		`Default branch: ${str(data.default_branch)} · ★ ${str(data.stargazers_count)} · forks ${str(data.forks_count)} · open issues+PRs ${str(data.open_issues_count)}`,
		`Language: ${str(data.language) || "—"}${topics ? ` · Topics: ${topics}` : ""}${data.license ? ` · License: ${str(record(data.license).spdx_id)}` : ""}`,
		`Updated ${day(data.pushed_at)} · ${str(data.html_url)}`,
	]
		.filter(Boolean)
		.join("\n");
}

function comments(items: Json[]): string[] {
	return items.map((item) => `--- ${login(item.user)} · ${day(item.created_at)}${item.path ? ` · ${str(item.path)}:${str(item.line ?? item.original_line)}` : ""}\n${clip(str(item.body), 1500)}`);
}

async function issueView(gh: GitHubClient, id: RepositoryIdentity, number: number): Promise<string> {
	const base = `${repoPath(id)}/issues/${number}`;
	const [issue, thread] = await Promise.all([gh.json(base), gh.json(`${base}/comments?per_page=30`)]);
	const data = record(issue);
	const labels = list(data.labels).map((label) => str(label.name)).join(", ");
	const discussion = list(thread);
	return [
		`#${number} ${str(data.title)} [${str(data.state)}${data.pull_request ? ", pull request" : ""}]`,
		`${login(data.user)} opened ${day(data.created_at)}${labels ? ` · labels: ${labels}` : ""}${data.assignees ? ` · assignees: ${list(data.assignees).map((a) => str(a.login)).join(", ") || "—"}` : ""}`,
		str(data.html_url),
		"",
		clip(str(data.body)) || "(no description)",
		...(discussion.length ? ["", `${str(data.comments)} comment(s):`, ...comments(discussion)] : []),
	].join("\n");
}

async function prView(gh: GitHubClient, id: RepositoryIdentity, number: number): Promise<string> {
	const base = `${repoPath(id)}/pulls/${number}`;
	const [pull, files, reviews, thread] = await Promise.all([
		gh.json(base),
		gh.json(`${base}/files?per_page=100`),
		gh.json(`${base}/reviews?per_page=30`),
		gh.json(`${repoPath(id)}/issues/${number}/comments?per_page=30`),
	]);
	const data = record(pull);
	const state = data.merged_at ? "merged" : data.draft ? "draft" : str(data.state);
	const changed = list(files);
	const verdicts = list(reviews).filter((review) => review.state !== "COMMENTED" || str(review.body));
	return [
		`PR #${number} ${str(data.title)} [${state}]`,
		`${login(data.user)} wants ${str(record(data.head).label)} → ${str(record(data.base).ref)} · opened ${day(data.created_at)}${data.mergeable_state ? ` · mergeable: ${str(data.mergeable_state)}` : ""}`,
		`+${str(data.additions)} −${str(data.deletions)} in ${str(data.changed_files)} file(s) · head ${str(record(data.head).sha).slice(0, 12)} · ${str(data.html_url)}`,
		"",
		clip(str(data.body)) || "(no description)",
		"",
		"Files:",
		...changed.map((file) => `  ${str(file.status).padEnd(8)} +${str(file.additions)} −${str(file.deletions)}  ${str(file.filename)}`),
		...(changed.length >= 100 ? ["  …(first 100 files)"] : []),
		...(verdicts.length ? ["", "Reviews:", ...verdicts.map((review) => `  ${login(review.user)}: ${str(review.state)}${str(review.body) ? ` — ${clip(str(review.body), 400)}` : ""}`)] : []),
		...(list(thread).length ? ["", "Comments:", ...comments(list(thread))] : []),
	].join("\n");
}

/** One file's section of a unified diff, by its path on either side. */
export function diffForFile(diff: string, path: string): string | null {
	const sections = diff.split(/^(?=diff --git )/m);
	return sections.find((section) => section.startsWith(`diff --git a/${path} `) || section.includes(` b/${path}\n`)) ?? null;
}

async function prDiff(gh: GitHubClient, id: RepositoryIdentity, number: number, path: string | undefined, offset: number): Promise<string> {
	const diff = await gh.text(`${repoPath(id)}/pulls/${number}`, "application/vnd.github.diff");
	const selected = path ? diffForFile(diff, path.replace(/^\.?\//, "")) : diff;
	if (selected === null) throw new Error(`PR #${number} does not change ${path}`);
	return page(selected, offset) || "(empty diff)";
}

const CHECK_ICON: Record<string, string> = { success: "✓", failure: "✗", cancelled: "⊘", skipped: "–", neutral: "·", timed_out: "✗", action_required: "!" };

async function prChecks(gh: GitHubClient, id: RepositoryIdentity, number: number | undefined, ref: string | undefined): Promise<string> {
	const sha = number ? str(record(record(await gh.json(`${repoPath(id)}/pulls/${number}`)).head).sha) : need(ref, "number or ref", "pr_checks");
	const [runs, status] = await Promise.all([
		gh.json(`${repoPath(id)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`),
		gh.json(`${repoPath(id)}/commits/${encodeURIComponent(sha)}/status`),
	]);
	const checks = list(record(runs).check_runs);
	const statuses = list(record(status).statuses);
	const lines = [
		...checks.map((check) => {
			const outcome = check.status === "completed" ? str(check.conclusion) : str(check.status);
			return `  ${CHECK_ICON[outcome] ?? "…"} ${str(check.name)} — ${outcome}${check.html_url ? ` · ${str(check.html_url)}` : ""}`;
		}),
		...statuses.map((entry) => `  ${entry.state === "success" ? "✓" : entry.state === "pending" ? "…" : "✗"} ${str(entry.context)} — ${str(entry.state)}${entry.description ? ` (${str(entry.description)})` : ""}`),
	];
	const failed = checks.filter((check) => ["failure", "timed_out", "action_required"].includes(str(check.conclusion))).length +
		statuses.filter((entry) => entry.state === "failure" || entry.state === "error").length;
	return [
		`Checks for ${number ? `PR #${number} ` : ""}${sha.slice(0, 12)}: ${lines.length} total, ${failed} failing`,
		...(lines.length ? lines : ["  (no checks reported)"]),
		...(failed ? ["", "For an Actions failure, find the run with op=runs and read its logs with op=run_view."] : []),
	].join("\n");
}

async function runs(gh: GitHubClient, id: RepositoryIdentity, ref: string | undefined, limit: number): Promise<string> {
	const query = new URLSearchParams({ per_page: String(limit) });
	if (ref) query.set("branch", ref);
	const data = list(record(await gh.json(`${repoPath(id)}/actions/runs?${query}`)).workflow_runs);
	if (data.length === 0) return `No workflow runs${ref ? ` on ${ref}` : ""}.`;
	return [
		`Recent workflow runs${ref ? ` on ${ref}` : ""}:`,
		...data.map((run) => {
			const outcome = run.status === "completed" ? str(run.conclusion) : str(run.status);
			return `  ${CHECK_ICON[outcome] ?? "…"} run ${str(run.id)} · ${str(run.name)} · ${outcome} · ${str(run.head_branch)}@${str(run.head_sha).slice(0, 7)} · ${str(run.event)} · ${day(run.created_at)}`;
		}),
	].join("\n");
}

/** The last lines of a job log, with GitHub's per-line timestamps stripped. */
export function logTail(log: string, lines = LOG_TAIL_LINES): string {
	const all = log.replace(/\r/g, "").split("\n").map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ""));
	while (all.length && !all[all.length - 1].trim()) all.pop();
	return (all.length > lines ? [`…(${all.length - lines} earlier lines)`, ...all.slice(-lines)] : all).join("\n");
}

async function runView(gh: GitHubClient, id: RepositoryIdentity, run: number): Promise<string> {
	const [info, jobsData] = await Promise.all([
		gh.json(`${repoPath(id)}/actions/runs/${run}`),
		gh.json(`${repoPath(id)}/actions/runs/${run}/jobs?per_page=100`),
	]);
	const data = record(info);
	const jobs = list(record(jobsData).jobs);
	const outcome = data.status === "completed" ? str(data.conclusion) : str(data.status);
	const out = [
		`Run ${run} · ${str(data.name)} · ${outcome} · ${str(data.head_branch)}@${str(data.head_sha).slice(0, 7)} · ${str(data.html_url)}`,
		"",
		"Jobs:",
	];
	const failed: Json[] = [];
	for (const job of jobs) {
		const jobOutcome = job.status === "completed" ? str(job.conclusion) : str(job.status);
		out.push(`  ${CHECK_ICON[jobOutcome] ?? "…"} ${str(job.name)} — ${jobOutcome}`);
		for (const step of list(job.steps)) {
			if (step.conclusion === "failure") out.push(`      ✗ step ${str(step.number)}: ${str(step.name)}`);
		}
		if (["failure", "timed_out"].includes(jobOutcome)) failed.push(job);
	}
	// Logs only for what failed, and only their tails: where an error is, and
	// all a model can use from a log thousands of lines long.
	for (const job of failed.slice(0, 3)) {
		out.push("", `=== Log tail: ${str(job.name)} ===`);
		try {
			out.push(logTail(await gh.text(`${repoPath(id)}/actions/jobs/${str(job.id)}/logs`, "application/vnd.github+json")));
		} catch (error) {
			out.push(`(log unavailable: ${error instanceof Error ? error.message : String(error)}${/401|404|token/.test(String(error)) ? " — Actions logs need a GitHub token" : ""})`);
		}
	}
	if (failed.length > 3) out.push("", `(${failed.length - 3} more failed jobs not shown)`);
	return out.join("\n");
}

async function fileRead(gh: GitHubClient, id: RepositoryIdentity, path: string, ref: string | undefined, offset: number): Promise<string> {
	const clean = path.replace(/^\.?\//, "").split("/").map(encodeURIComponent).join("/");
	const text = await gh.text(`${repoPath(id)}/contents/${clean}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, "application/vnd.github.raw+json");
	if (text.startsWith("[") && text.includes('"type":"')) throw new Error(`${path} is a directory in ${id.owner}/${id.repo}`);
	if (text.includes("\u0000")) throw new Error(`${path} is a binary file`);
	return `${id.owner}/${id.repo}/${path}${ref ? ` @ ${ref}` : ""}\n\n${page(text, offset)}`;
}

/** Scope a search to the repository unless the query already names a scope. */
export function scopedQuery(query: string, kind: string, id: RepositoryIdentity | null): string {
	const parts = [query.trim()];
	if (kind === "issues" && !/\bis:(issue|pr)\b/.test(query)) parts.push("is:issue");
	if (kind === "prs" && !/\bis:(issue|pr)\b/.test(query)) parts.push("is:pr");
	if (id && kind !== "repos" && !/\b(repo|org|user):/.test(query)) parts.push(`repo:${id.owner}/${id.repo}`);
	return parts.filter(Boolean).join(" ");
}

async function search(gh: GitHubClient, auth: GitHubAuthService, cwd: string, input: Input, limit: number): Promise<string> {
	// Typed by hand: the schema builds its union from an array, which Static cannot narrow.
	const kind = need(input.kind as (typeof SEARCH_KINDS)[number] | undefined, "kind", "search");
	const query = need(input.query, "query", "search");
	let id: RepositoryIdentity | null = null;
	if (kind !== "repos") id = await resolveRepo(auth, cwd, input.repo).catch(() => null);
	const q = scopedQuery(query, kind, id);
	// GitHub's repository search route is /search/repositories, not /search/repos.
	const endpoint = kind === "prs" ? "issues" : kind === "repos" ? "repositories" : kind;
	const data = record(await gh.json(`/search/${endpoint}?${new URLSearchParams({ q, per_page: String(limit) })}`));
	const items = list(data.items);
	const header = `${str(data.total_count)} result(s) for \`${q}\`${items.length < Number(data.total_count) ? ` (showing ${items.length})` : ""}:`;
	const lines = items.map((item) => {
		switch (kind) {
			case "code":
				return `  ${str(record(item.repository).full_name)}/${str(item.path)} · ${str(item.html_url)}`;
			case "repos":
				return `  ${str(item.full_name)} ★${str(item.stargazers_count)} — ${clip(str(item.description), 160)}`;
			case "commits":
				return `  ${str(item.sha).slice(0, 7)} ${clip(str(record(item.commit).message).split("\n")[0], 160)} · ${login(item.author)} · ${day(record(record(item.commit).author).date)}`;
			default:
				return `  #${str(item.number)} [${str(item.state)}] ${str(item.title)} · ${login(item.user)} · ${day(item.updated_at)}`;
		}
	});
	return [header, ...lines].join("\n");
}

export function createGithubTool(cwd: string): ToolDefinition {
	return {
		name: GITHUB_TOOL_NAME,
		label: GITHUB_TOOL_NAME,
		description:
			"Read GitHub: repository overview, issues and PRs with their discussion, PR diffs, CI checks, Actions runs with failed-job log tails, files at any ref, and search. Pick with `op`; `repo` defaults to this workspace's github.com remote. Read-only. Use this rather than curl or web_fetch for anything on GitHub; for CI failures go pr_checks → runs → run_view.",
		promptSnippet: "github(op=pr_view|pr_diff|pr_checks|runs|run_view|issue_view|file_read|search|repo_view) reads GitHub without the gh CLI.",
		parameters: schema,
		executionMode: "parallel",
		async execute(_id, params, signal) {
			const input = params as Input;
			const auth = authSource();
			if (!auth) throw new Error("GitHub is unavailable in this session");
			const gh = new GitHubClient(auth, signal);
			const limit = input.limit ?? 10;
			const offset = input.offset ?? 0;
			const id = () => resolveRepo(auth, cwd, input.repo);
			let text: string;
			switch (input.op as Op) {
				case "repo_view":
					text = await repoView(gh, await id());
					break;
				case "issue_view":
					text = await issueView(gh, await id(), need(input.number, "number", input.op));
					break;
				case "pr_view":
					text = await prView(gh, await id(), need(input.number, "number", input.op));
					break;
				case "pr_diff":
					text = await prDiff(gh, await id(), need(input.number, "number", input.op), input.path, offset);
					break;
				case "pr_checks":
					text = await prChecks(gh, await id(), input.number, input.ref);
					break;
				case "runs":
					text = await runs(gh, await id(), input.ref, limit);
					break;
				case "run_view":
					text = await runView(gh, await id(), need(input.run, "run", input.op));
					break;
				case "file_read":
					text = await fileRead(gh, await id(), need(input.path, "path", input.op), input.ref, offset);
					break;
				case "search":
					text = await search(gh, auth, cwd, input, limit);
					break;
				default:
					throw new Error(`Unknown op: ${String(input.op)}`);
			}
			return { content: [{ type: "text", text }], details: { op: input.op } };
		},
	};
}
