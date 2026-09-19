import { describe, expect, test } from "bun:test";
import { version } from "../../package.json";
import { RELEASES_URL, UPDATE_REPOSITORY } from "../shared/updates";
import { appVersionInfo, AppUpdateService } from "./app-updates";

const release = (patch = {}) => ({ tag_name: "v1.10.0", name: "NekoCode 1.10", draft: false, prerelease: false, body: "Update notes", published_at: "2026-09-19T00:00:00Z", html_url: "https://untrusted.example/", ...patch });
const service = (body: unknown = release(), currentVersion = "1.9.0") => new AppUpdateService({ currentVersion: () => currentVersion, fetch: async () => Response.json(body) });

describe("GitHub release updates", () => {
	test("startup checks once per process while manual checks can refresh", async () => {
		let calls = 0;
		const checker = new AppUpdateService({ currentVersion: () => "0.0.1", fetch: async () => {
			calls++;
			return Response.json(release());
		} });
		await Promise.all([checker.checkOnStartup(), checker.checkOnStartup()]);
		await checker.checkOnStartup();
		expect(calls).toBe(1);
		await checker.check();
		expect(calls).toBe(2);
	});

	test("dismissing a startup notice survives renderer reloads but leaves manual checks available", async () => {
		const checker = service();
		expect((await checker.checkOnStartup())?.status).toBe("available");
		checker.dismissStartupUpdate();
		expect(await checker.checkOnStartup()).toBeNull();
		expect((await checker.check()).status).toBe("available");
		expect((await service().checkOnStartup())?.status).toBe("available");
	});

	test("an automatic failure does not prevent a successful manual retry", async () => {
		let calls = 0;
		const checker = new AppUpdateService({ currentVersion: () => "0.0.1", fetch: async () => {
			if (++calls === 1) throw new TypeError("offline");
			return Response.json(release());
		} });
		expect((await checker.checkOnStartup())?.status).toBe("error");
		expect((await checker.check()).status).toBe("available");
	});
	test("development builds show the project version, packaged builds show the app version", () => {
		expect(appVersionInfo(false, "44.3.0")).toEqual({ version, development: true, releasesUrl: RELEASES_URL });
		expect(appVersionInfo(true, "1.9.0").version).toBe("1.9.0");
	});

	test("reports a newer release with a repository-bound download destination", async () => {
		const result = await service().check();
		expect(result).toMatchObject({ status: "available", currentVersion: "1.9.0", release: { version: "1.10.0", notes: "Update notes", url: `${RELEASES_URL}/tag/v1.10.0` } });
		expect(result.checkedAt).toBeGreaterThan(0);
	});
	test.each([["1.10.0", "up-to-date"], ["2.0.0", "ahead"], ["1.10.0-rc.1", "available"]] as const)("current %s returns %s", async (current, status) => {
		expect((await service(release(), current).check()).status).toBe(status);
	});
	test.each([{ draft: true }, { prerelease: true }, { tag_name: "v1.10.0-beta.1" }, { tag_name: "latest" }])("does not offer drafts, prereleases or malformed tags: %j", async (patch) => {
		expect(await service(release(patch)).check()).toMatchObject({ status: "error", error: "invalid-release" });
	});
	test("no latest release is distinct from an inaccessible repository", async () => {
		for (const accessible of [true, false]) {
			const urls: string[] = [];
			const checker = new AppUpdateService({ currentVersion: () => "0.0.1", fetch: async (url) => {
				urls.push(url);
				return accessible && url.endsWith("?per_page=1") ? Response.json([]) : new Response(null, { status: 404 });
			} });
			expect(await checker.check()).toMatchObject(accessible ? { status: "no-release" } : { status: "error", error: "unavailable" });
			expect(urls).toEqual([`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`, `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=1`]);
		}
	});
	test.each([[429, "rate-limit"], [401, "unavailable"], [503, "server"]])("HTTP %s is reported as %s", async (status, error) => {
		const checker = new AppUpdateService({ currentVersion: () => "0.0.1", fetch: async () => new Response(null, { status: Number(status) }) });
		expect(await checker.check()).toMatchObject({ status: "error", error });
	});
	test("recognizes GitHub's 403 rate-limit response", async () => {
		const checker = new AppUpdateService({ currentVersion: () => "0.0.1", fetch: async () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } }) });
		expect(await checker.check()).toMatchObject({ status: "error", error: "rate-limit" });
	});
	test("network and malformed JSON errors never mean up to date", async () => {
		const network = new AppUpdateService({ currentVersion: () => "0.0.1", fetch: async () => { throw new TypeError("offline"); } });
		expect(await network.check()).toMatchObject({ status: "error", error: "network" });
		const malformed = new AppUpdateService({ currentVersion: () => "0.0.1", fetch: async () => new Response("not JSON") });
		expect(await malformed.check()).toMatchObject({ status: "error", error: "invalid-release" });
	});
	test("aborts a slow request and allows another check", async () => {
		const checker = new AppUpdateService({ currentVersion: () => "0.0.1", timeoutMs: 5, fetch: async (_url, init) => new Promise((_resolve, reject) => {
			init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}) });
		expect(await checker.check()).toMatchObject({ status: "error", error: "timeout" });
		expect(await checker.check()).toMatchObject({ status: "error", error: "timeout" });
	});
	test("shares in-flight checks, then fetches again on an explicit recheck", async () => {
		let calls = 0;
		const checker = new AppUpdateService({ currentVersion: () => "0.0.1", resolveToken: async () => "test-token", fetch: async (url, init) => {
			calls++;
			expect(url).toBe(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`);
			expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
			expect(init.redirect).toBe("error");
			return Response.json(release());
		} });
		const first = checker.check();
		expect(checker.check()).toBe(first);
		await first;
		expect(calls).toBe(1);
		await checker.check();
		expect(calls).toBe(2);
	});
	test("does not fetch when the installed version is invalid", async () => {
		const checker = new AppUpdateService({ currentVersion: () => "unknown", fetch: async () => { throw new Error("should not fetch"); } });
		expect(await checker.check()).toMatchObject({ status: "error", error: "invalid-version" });
	});
});
