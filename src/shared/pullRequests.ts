/** Pull-request panel contracts. Backed by the GitHub REST API. */

export type PullRequestState = "open" | "closed" | "merged" | "draft";
export type PullRequestFilter = "open" | "closed" | "all";

export type CheckState = "success" | "failure" | "pending" | "neutral" | "skipped";

export interface CheckRollup {
	success: number;
	failure: number;
	pending: number;
	total: number;
}

export interface PullRequestSummary {
	number: number;
	title: string;
	state: PullRequestState;
	draft: boolean;
	author: string;
	authorAvatarUrl?: string;
	headRef: string;
	baseRef: string;
	createdAt: string;
	updatedAt: string;
	url: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	comments: number;
	checks: CheckRollup;
}

export interface PullRequestComment {
	id: number;
	author: string;
	authorAvatarUrl?: string;
	body: string;
	createdAt: string;
	url: string;
	/** Present for review comments, which are anchored to a file and line. */
	path?: string;
	line?: number;
}

export interface PullRequestDetail extends PullRequestSummary {
	body: string;
	mergeable: boolean | null;
	merged: boolean;
	checkRuns: { name: string; state: CheckState; url?: string }[];
	issueComments: PullRequestComment[];
	reviewComments: PullRequestComment[];
}

/** Repository resolved from the project's git remotes. */
export interface RepositoryIdentity {
	owner: string;
	repo: string;
	/** GitHub host; "github.com" for public GitHub, otherwise a GitHub Enterprise host. */
	host: string;
}

export interface PullRequestListResult {
	repository: RepositoryIdentity | null;
	pullRequests: PullRequestSummary[];
	/** Set when the list is empty because something went wrong rather than because it is empty. */
	notice?: string;
}

export interface GitHubAuthStatus {
	configured: boolean;
	source: "settings" | "gh-cli" | "anonymous" | null;
	login?: string;
	encryptionAvailable: boolean;
	warning?: string;
}

export interface CreatePullRequestRequest {
	cwd: string;
	title: string;
	body: string;
	base: string;
	head: string;
	draft: boolean;
}

export interface RepositoryBranch {
	name: string;
	isCurrent: boolean;
}
