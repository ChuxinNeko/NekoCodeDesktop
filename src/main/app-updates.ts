import { version as packageVersion } from "../../package.json";
import {
	compareVersions, parseVersion, RELEASES_URL, UPDATE_REPOSITORY,
	type AppVersionInfo, type UpdateCheckResult, type UpdateError,
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

	private async request(): Promise<UpdateCheckResult> {
		const currentVersion = this.options.currentVersion();
		const base = () => ({ currentVersion, checkedAt: Date.now() });
		const fail = (error: UpdateError): UpdateCheckResult => ({ ...base(), status: "error", error });
		if (!parseVersion(currentVersion)) return fail("invalid-version");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
		try {
			const token = await this.options.resolveToken?.();
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
