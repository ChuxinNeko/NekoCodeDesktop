import { describe, expect, test } from "bun:test";
import { githubErrorMessage, parseRemoteUrl, toSummary } from "./pull-request-service";

describe("parseRemoteUrl", () => {
	test("parses scp-style and https remotes", () => {
		expect(parseRemoteUrl("git@github.com:owner/repo.git")).toEqual({
			owner: "owner",
			repo: "repo",
			host: "github.com",
		});
		expect(parseRemoteUrl("https://github.com/owner/repo.git")).toEqual({
			owner: "owner",
			repo: "repo",
			host: "github.com",
		});
		expect(parseRemoteUrl("https://github.com/owner/repo")).toEqual({
			owner: "owner",
			repo: "repo",
			host: "github.com",
		});
		expect(parseRemoteUrl("ssh://git@github.com/owner/repo.git")).toEqual({
			owner: "owner",
			repo: "repo",
			host: "github.com",
		});
	});

	test("rejects non-GitHub remotes, including GitHub Enterprise hosts", () => {
		expect(parseRemoteUrl("git@gitlab.com:owner/repo.git")).toBeNull();
		expect(parseRemoteUrl("https://example.com/owner/repo.git")).toBeNull();
		expect(parseRemoteUrl("git@github.com:owner.git")).toBeNull();
		expect(parseRemoteUrl("")).toBeNull();
		// GHE needs its own API base and token, so it is not half-supported.
		expect(parseRemoteUrl("git@ghe.corp.example:team/service.git")).toBeNull();
	});
});

describe("toSummary", () => {
	test("maps state, draft, branches, and author", () => {
		const summary = toSummary({
			number: 42,
			title: "Add scheduler",
			state: "open",
			draft: false,
			user: { login: "octocat", avatar_url: "https://example.com/a.png" },
			head: { ref: "feature/scheduler" },
			base: { ref: "main" },
			created_at: "2026-03-01T00:00:00Z",
			updated_at: "2026-03-02T00:00:00Z",
			html_url: "https://github.com/owner/repo/pull/42",
			additions: 120,
			deletions: 7,
			changed_files: 4,
			comments: 3,
		});
		expect(summary).toMatchObject({
			number: 42,
			state: "open",
			author: "octocat",
			headRef: "feature/scheduler",
			baseRef: "main",
			additions: 120,
			deletions: 7,
			changedFiles: 4,
			comments: 3,
		});
	});

	test("prefers merged and draft over the raw state field", () => {
		expect(toSummary({ state: "closed", merged_at: "2026-03-02T00:00:00Z" }).state).toBe("merged");
		expect(toSummary({ state: "open", draft: true }).state).toBe("draft");
		expect(toSummary({ state: "closed" }).state).toBe("closed");
	});

	test("tolerates a payload with missing fields", () => {
		const summary = toSummary({ number: 1 });
		expect(summary.title).toBe("#1");
		expect(summary.author).toBe("unknown");
		expect(summary.additions).toBe(0);
		expect(summary.checks.total).toBe(0);
	});
});

describe("githubErrorMessage", () => {
	test("explains the anonymous rate limit differently from an authenticated one", () => {
		expect(githubErrorMessage(403, "", false)).toMatch(/匿名限流/);
		expect(githubErrorMessage(403, "", true)).toMatch(/权限不足/);
	});

	test("distinguishes a private repository from a bad token", () => {
		expect(githubErrorMessage(404, "", false)).toMatch(/私有仓库/);
		expect(githubErrorMessage(401, "", true)).toMatch(/token/);
	});

	test("surfaces the API message when one is present", () => {
		expect(githubErrorMessage(422, JSON.stringify({ message: "Validation Failed" }), true)).toContain(
			"Validation Failed",
		);
	});
});
