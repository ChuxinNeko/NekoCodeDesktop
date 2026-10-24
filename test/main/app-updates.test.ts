import { expect, test } from "bun:test";
import { AppUpdateService } from "../../src/main/app-updates";

function release() {
	return Response.json({ tag_name: "v0.3.0", draft: false, prerelease: false });
}

test("slow credential lookup falls back to anonymous without consuming the HTTP budget", async () => {
	let authorization: string | null = "not-called";
	const service = new AppUpdateService({
		currentVersion: () => "0.2.1",
		tokenTimeoutMs: 30,
		timeoutMs: 10,
		resolveToken: () => new Promise(() => {}),
		fetch: async (_url, init) => {
			expect(init.signal?.aborted).toBe(false);
			authorization = new Headers(init.headers).get("authorization");
			return release();
		},
	});
	expect((await service.check()).status).toBe("available");
	expect(authorization).toBeNull();
});

test("credential failure does not block public release checks", async () => {
	const service = new AppUpdateService({
		currentVersion: () => "0.2.1",
		resolveToken: async () => { throw new Error("OAuth refresh unavailable"); },
		fetch: async (_url, init) => {
			expect(new Headers(init.headers).has("authorization")).toBe(false);
			return release();
		},
	});
	expect((await service.check()).status).toBe("available");
});

test("available credentials are retained and concurrent checks share a request", async () => {
	let requests = 0;
	const service = new AppUpdateService({
		currentVersion: () => "0.2.1",
		resolveToken: async () => "test-token",
		fetch: async (_url, init) => {
			requests++;
			expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
			return release();
		},
	});
	const [first, second] = await Promise.all([service.check(), service.check()]);
	expect(first.status).toBe("available");
	expect(second).toBe(first);
	expect(requests).toBe(1);
});

test("HTTP timeout aborts the request and a manual retry can succeed", async () => {
	let requests = 0;
	const service = new AppUpdateService({
		currentVersion: () => "0.2.1",
		timeoutMs: 10,
		fetch: async (_url, init) => {
			if (++requests > 1) return release();
			return new Promise<Response>((_resolve, reject) => {
				init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
			});
		},
	});
	expect(await service.check()).toMatchObject({ status: "error", error: "timeout" });
	expect((await service.check()).status).toBe("available");
});
