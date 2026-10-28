import { appDataPath } from "./linux-profile-paths";
import { safeStorage } from "./profile-encryption";
import { GitHubCredentialStore } from "./github-credential-store";
import type { GitHubFetch } from "./github-network";

/** Desktop adapter; credential lifecycle is testable without an Electron process. */
export class GitHubAuthService extends GitHubCredentialStore {
	constructor(request: GitHubFetch = fetch) {
		super({ userDataDir: appDataPath(), encryption: safeStorage, request });
	}
}
