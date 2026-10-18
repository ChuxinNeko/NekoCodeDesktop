import { app, safeStorage } from "electron";
import { GitHubCredentialStore } from "./github-credential-store";

/** Desktop adapter; credential lifecycle is testable without an Electron process. */
export class GitHubAuthService extends GitHubCredentialStore {
	constructor() {
		super({ userDataDir: app.getPath("userData"), encryption: safeStorage });
	}
}
