import { version as packageVersion } from "../../package.json";
import {
	compareVersions, parseVersion, RELEASES_URL, UPDATE_REPOSITORY,
	type AppVersionInfo, type UpdateCheckResult, type UpdateError, type UpdateInstallState,
} from "../shared/updates";

export function appVersionInfo(packaged: boolean, runtimeVersion: string): AppVersionInfo {
	// electron out/main/index.js can report Electron's version instead of ours.
	return { version: packaged ? runtimeVersion : packageVersion, development: !packaged, releasesUrl: RELEASES_URL };
}

export class AppUpdateService {
	private pending: Promise<UpdateCheckResult> | null = null;
	private startupCheck: Promise<UpdateCheckResult> | null = null;
	private startupDismissed = false;
	constructor(private readonly options: {
		currentVersion: () => string;
		resolveToken?: () => Promise<string | null>;
		tokenTimeoutMs?: number;
		fetch?: (url: string, init: RequestInit) => Promise<Response>;
		timeoutMs?: number;
	}) {}

	check(): Promise<UpdateCheckResult> {
		// A repeated click or another window shares the same in-flight request.
		if (!this.pending) this.pending = this.request().finally(() => { this.pending = null; });
		return this.pending;
	}

	/** Once per app process; manual checks can still retry after a startup failure. */
	async checkOnStartup(): Promise<UpdateCheckResult | null> {
		const result = await (this.startupCheck ??= this.check());
		return this.startupDismissed ? null : result;
	}

	dismissStartupUpdate(): void {
		this.startupDismissed = true;
	}

	private async optionalToken(): Promise<string | null> {
		if (!this.options.resolveToken) return null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// Releases are public: a slow gh invocation or OAuth refresh must not
			// consume the HTTP deadline or prevent an anonymous update check.
			return await Promise.race([
				Promise.resolve().then(() => this.options.resolveToken!()).catch(() => null),
				new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.options.tokenTimeoutMs ?? 3_000); }),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async request(): Promise<UpdateCheckResult> {
		const currentVersion = this.options.currentVersion();
		const base = () => ({ currentVersion, checkedAt: Date.now() });
		const fail = (error: UpdateError): UpdateCheckResult => ({ ...base(), status: "error", error });
		if (!parseVersion(currentVersion)) return fail("invalid-version");
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const token = await this.optionalToken();
			// Give the request its full budget, separately from optional auth.
			timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
			const fetchRelease = this.options.fetch ?? fetch;
			const init: RequestInit = {
				headers: {
					accept: "application/vnd.github+json",
					"x-github-api-version": "2022-11-28",
					"user-agent": "NekoCodeDesktop",
					...(token ? { authorization: `Bearer ${token}` } : {}),
				},
				signal: controller.signal,
				redirect: "error",
			};
			const endpoint = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases`;
			let response = await fetchRelease(`${endpoint}/latest`, init);
			if (response.status === 404) {
				// GitHub also returns 404 for a private/inaccessible repository. Do not
				// misreport that as "no releases" or "already up to date".
				response = await fetchRelease(`${endpoint}?per_page=1`, init);
				if (response.ok) {
					const list: unknown = await response.json();
					return Array.isArray(list) ? { ...base(), status: "no-release" } : fail("invalid-release");
				}
			}
			if (response.status === 429 || (response.status === 403 &&
				(response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))))
				return fail("rate-limit");
			if ([401, 403, 404].includes(response.status)) return fail("unavailable");
			if (!response.ok) return fail("server");
			const data = await response.json() as Record<string, unknown> | null;
			if (!data || typeof data.tag_name !== "string" || data.draft !== false || data.prerelease !== false)
				return fail("invalid-release");
			const version = parseVersion(data.tag_name);
			if (!version || version.prerelease.length) return fail("invalid-release");
			const comparison = compareVersions(data.tag_name, currentVersion)!;
			return {
				...base(), status: comparison > 0 ? "available" : comparison < 0 ? "ahead" : "up-to-date",
				release: {
					version: data.tag_name.replace(/^v/, ""), tag: data.tag_name,
					name: typeof data.name === "string" && data.name ? data.name : data.tag_name,
					// Construct the destination from our trusted repository, not response html_url.
					url: `${RELEASES_URL}/tag/${encodeURIComponent(data.tag_name)}`,
					notes: typeof data.body === "string" ? data.body.slice(0, 50_000) : "",
					publishedAt: typeof data.published_at === "string" && Number.isFinite(Date.parse(data.published_at)) ? data.published_at : null,
				},
			};
		} catch (error) {
			return fail(controller.signal.aborted ? "timeout" : error instanceof SyntaxError ? "invalid-release" : "network");
		} finally {
			clearTimeout(timer);
		}
	}
}

/** The part of electron-updater's AppUpdater that downloading and installing a release uses. */
export interface InstallUpdater {
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
	autoRunAppAfterInstall: boolean;
	setFeedURL(options: { provider: "generic"; url: string; useMultipleRangeRequest: boolean }): void;
	checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>;
	downloadUpdate(): Promise<unknown>;
	quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
	on(event: "download-progress", listener: (progress: { transferred: number; total: number }) => void): unknown;
}

/**
 * Downloads a release found by AppUpdateService and installs it on restart.
 * electron-updater fetches only the blocks of the installer that changed since
 * the installed version (the NSIS installer keeps a copy of itself for this;
 * an AppImage diffs against itself), falling back to a full download.
 */
export class AppInstallService {
	private current: UpdateInstallState;
	private updater: Promise<InstallUpdater> | null = null;
	private pending: Promise<UpdateInstallState> | null = null;
	constructor(private readonly options: {
		supported: boolean;
		platform?: NodeJS.Platform;
		currentVersion: () => string;
		loadUpdater: () => Promise<InstallUpdater>;
		publish: (state: UpdateInstallState) => void;
	}) {
		this.current = options.supported ? { phase: "idle" } : { phase: "unsupported" };
	}

	state(): UpdateInstallState {
		return this.current;
	}

	download(tag: unknown): Promise<UpdateInstallState> {
		if (this.current.phase === "unsupported") return Promise.resolve(this.current);
		if (this.current.phase === "installing") return Promise.resolve(this.current);
		const parsed = typeof tag === "string" ? parseVersion(tag) : null;
		if (typeof tag !== "string" || !parsed || parsed.prerelease.length || !(compareVersions(tag, this.options.currentVersion())! > 0))
			return Promise.reject(new Error("Invalid update version"));
		// One download at a time; another window's click joins it.
		if (this.pending) return this.pending;
		const version = tag.replace(/^v/, "");
		if (this.current.phase === "downloaded" && this.current.version === version) return Promise.resolve(this.current);
		this.pending = this.run(tag, version).finally(() => { this.pending = null; });
		return this.pending;
	}

	async install(): Promise<void> {
		if (this.current.phase === "installing") return;
		if (this.current.phase !== "downloaded" || !this.updater) throw new Error("No downloaded update to install");
		const version = this.current.version;
		this.set({ phase: "installing", version });
		try {
			const updater = await this.updater;
			// Windows hands feedback to the NSIS progress window, which outlives
			// Electron. Our update-only NSIS hooks skip setup choices and restart.
			updater.quitAndInstall((this.options.platform ?? process.platform) !== "win32", true);
		} catch (error) {
			// Keep the downloaded installer available for another attempt.
			this.set({ phase: "downloaded", version });
			throw error;
		}
	}

	private async run(tag: string, version: string): Promise<UpdateInstallState> {
		this.set({ phase: "downloading", version, transferred: 0, total: 0 });
		try {
			const updater = await (this.updater ??= this.prepare().catch((error: unknown) => {
				this.updater = null;
				throw error;
			}));
			// The release the check showed, from its own tag — not whatever is Latest by now.
			updater.setFeedURL({
				provider: "generic",
				url: `${RELEASES_URL}/download/${encodeURIComponent(tag)}`,
				// GitHub's asset CDN answers one range per request.
				useMultipleRangeRequest: false,
			});
			const result = await updater.checkForUpdates();
			if (result?.updateInfo.version !== version) throw new Error(`Release ${tag} has no update metadata for this platform`);
			await updater.downloadUpdate();
			this.set({ phase: "downloaded", version });
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
			this.set({ phase: "error", version, message });
		}
		return this.current;
	}

	private async prepare(): Promise<InstallUpdater> {
		const updater = await this.options.loadUpdater();
		updater.autoDownload = false;
		updater.autoRunAppAfterInstall = true;
		// A download the user did not restart for is installed when the app quits.
		updater.autoInstallOnAppQuit = true;
		updater.on("download-progress", ({ transferred, total }) => {
			if (this.current.phase === "downloading") this.set({ ...this.current, transferred, total });
		});
		return updater;
	}

	private set(state: UpdateInstallState): void {
		this.current = state;
		this.options.publish(state);
	}
}
