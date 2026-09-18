import { describe, expect, test } from "bun:test";
import { request } from "node:http";
import { createServer } from "node:net";
import { parseAuthorizationInput, startCallbackServer } from "./oauth-callback-server";

function get(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path }, (res) => {
			let body = "";
			res.on("data", (chunk) => { body += String(chunk); });
			res.on("end", () => resolve({ status: res.statusCode!, body }));
		});
		req.once("error", reject); req.end();
	});
}

describe("OAuth loopback callback", () => {
	test("rejects bare codes and accepts reference callback representations", () => {
		expect(() => parseAuthorizationInput("bare-code")).toThrow();
		for (const value of [
			"http://localhost:51121/oauth-callback?code=one&state=two", "?code=one&state=two",
			"code=one&state=two", "http://localhost:51121/oauth-callback#code=one&state=two",
		]) expect(parseAuthorizationInput(value)).toMatchObject({ code: "one", state: "two" });
	});

	test("wrong state and unrelated routes cannot consume the pending login", async () => {
		const server = await startCallbackServer({ port: 0, path: "/oauth-callback", state: "expected" });
		try {
			expect((await get(server.port, "/favicon.ico")).status).toBe(404);
			expect((await get(server.port, "/oauth-callback?code=bad&state=wrong")).status).toBe(400);
			expect((await get(server.port, "/oauth-callback?error=denied&state=wrong")).status).toBe(400);
			expect(() => server.submit("code=pasted")).toThrow("state");
			expect(() => server.submit("code=pasted&state=wrong")).toThrow("state");
			expect((await get(server.port, "/oauth-callback?code=good&state=expected")).status).toBe(200);
			expect(await server.waitForCode()).toBe("good");
		} finally { server.close(); }
	});

	test("manual callback requires the expected state and can complete login", async () => {
		const server = await startCallbackServer({ port: 0, path: "/oauth-callback", state: "expected" });
		try {
			server.submit("http://localhost:51121/oauth-callback?code=manual&state=expected");
			expect(await server.waitForCode()).toBe("manual");
		} finally { server.close(); }
	});

	test("denial is escaped and cancellation resolves pending waiters", async () => {
		const server = await startCallbackServer({ port: 0, path: "/oauth-callback", state: "expected" });
		try {
			const res = await get(server.port, "/oauth-callback?state=expected&error=%3Cscript%3E");
			expect(res.body).not.toContain("<script>");
			expect(res.body).toContain("&lt;script&gt;");
			expect(await server.waitForCode()).toBeNull();
		} finally { server.close(); }
		const cancelled = await startCallbackServer({ port: 0, path: "/oauth-callback", state: "expected" });
		cancelled.close();
		expect(await cancelled.waitForCode()).toBeNull();
	});

	test("an occupied IPv4 callback port fails even if IPv6 is available", async () => {
		const occupied = createServer();
		await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
		const port = (occupied.address() as import("node:net").AddressInfo).port;
		try {
			await expect(startCallbackServer({ port, path: "/oauth-callback", state: "test" })).rejects.toThrow("不可用");
		} finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
	});
});
