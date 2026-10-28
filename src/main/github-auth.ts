import { app, safeStorage } from "electron";
import { GitHubCredentialStore } from "./github-credential-store";
import type { GitHubFetch } from "./github-network";

/** Desktop adapter; credential lifecycle is testable without an Electron process. */
export class GitHubAuthService extends GitHubCredentialStore {
	constructor(request: GitHubFetch = fetch) {
		super({ userDataDir: app.getPath("userData"), encryption: safeStorage, request });
	}
}
