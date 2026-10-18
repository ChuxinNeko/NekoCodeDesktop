/** Public GitHub account details shown on the settings page. No tokens. */

export interface GitHubAccount {
	login: string;
	name: string | null;
	avatarUrl: string | null;
	htmlUrl: string;
	bio: string | null;
	company: string | null;
	location: string | null;
	publicRepos: number;
	followers: number;
	following: number;
}

export interface GitHubRepository {
	name: string;
	fullName: string;
	description: string | null;
	private: boolean;
	fork: boolean;
	htmlUrl: string;
	language: string | null;
	stars: number;
	updatedAt: string;
}

export interface GitHubProfile {
	account: GitHubAccount;
	repositories: GitHubRepository[];
	/** The account loaded, but the repository list did not. */
	repositoriesWarning?: string;
	/** GitHub returned another page beyond the ones shown here. */
	truncated?: boolean;
}
