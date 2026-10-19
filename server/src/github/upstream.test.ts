import { expect, test } from "bun:test";
import { githubProxyOrigin, githubUpstreamFetch, rewriteGitHubUrl } from "./upstream";

const proxy = "https://gh.example.com";

test("代理地址只接受 HTTPS 根地址", () => {
	expect(githubProxyOrigin(undefined)).toBeUndefined();
	expect(githubProxyOrigin("  https://gh.example.com/  ")).toBe(proxy);
	expect(githubProxyOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
	expect(() => githubProxyOrigin("http://gh.example.com")).toThrow("HTTPS");
	expect(() => githubProxyOrigin("https://user:pass@gh.example.com")).toThrow("根地址");
	expect(() => githubProxyOrigin("https://gh.example.com/github")).toThrow("根地址");
	expect(() => githubProxyOrigin("not a url")).toThrow("合法");
});

test("只改写换 token、设备码和安装检查", () => {
	expect(rewriteGitHubUrl("https://github.com/login/oauth/access_token", proxy)).toBe(`${proxy}/https://github.com/login/oauth/access_token`);
	expect(rewriteGitHubUrl("https://github.com/login/device/code", proxy)).toBe(`${proxy}/https://github.com/login/device/code`);
	expect(rewriteGitHubUrl("https://api.github.com/user/installations?per_page=100&page=1", proxy)).toBe(`${proxy}/https://api.github.com/user/installations?per_page=100&page=1`);
	expect(rewriteGitHubUrl("https://api.github.com/user/installations/42/repositories?per_page=1", proxy)).toBe(`${proxy}/https://api.github.com/user/installations/42/repositories?per_page=1`);
	expect(rewriteGitHubUrl("https://github.com/login/oauth/authorize?client_id=id", proxy)).toBeNull();
	expect(rewriteGitHubUrl("https://github.com/apps/neko/installations/new", proxy)).toBeNull();
	expect(rewriteGitHubUrl("https://api.github.com/user", proxy)).toBeNull();
	expect(rewriteGitHubUrl("https://example.com/login/oauth/access_token", proxy)).toBeNull();
});

test("未配置代理时请求原样发出", async () => {
	const seen: string[] = [];
	const inner = (async (input: string) => {
		seen.push(input);
		return new Response("ok");
	}) as unknown as typeof fetch;
	const direct = githubUpstreamFetch(undefined, inner);
	await direct("https://github.com/login/oauth/access_token");
	const proxied = githubUpstreamFetch(proxy, inner);
	await proxied("https://github.com/login/device/code", { method: "POST" });
	await proxied("https://github.com/login/oauth/authorize");
	expect(seen).toEqual([
		"https://github.com/login/oauth/access_token",
		`${proxy}/https://github.com/login/device/code`,
		"https://github.com/login/oauth/authorize",
	]);
});
