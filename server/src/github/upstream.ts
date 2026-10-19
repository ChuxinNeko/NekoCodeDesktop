/**
 * Point the authorization server's GitHub calls at a US reverse proxy
 * (gitproxy). The user's browser still opens github.com itself; only the
 * server-side token exchange and installation check are rewritten.
 *
 * gitproxy expects `https://proxy.example/https://github.com/login/oauth/access_token`.
 */

const GITHUB_OAUTH = new Set(["/login/device/code", "/login/oauth/access_token"]);

export function githubProxyOrigin(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("GITHUB_PROXY_URL 不是合法的 URL");
	}
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
		throw new Error("GITHUB_PROXY_URL 只能是代理的根地址");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
		throw new Error("GITHUB_PROXY_URL 必须是 HTTPS（本机开发可使用 HTTP）");
	}
	return url.origin;
}

/** Return the proxied URL, or null when this call should go to GitHub directly. */
export function rewriteGitHubUrl(target: string, proxyOrigin: string): string | null {
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password) return null;
	const host = url.hostname.toLowerCase();
	if (host === "github.com" || host === "www.github.com") {
		if (!GITHUB_OAUTH.has(url.pathname)) return null;
	} else if (host === "api.github.com") {
		if (url.pathname !== "/user/installations" && !/^\/user\/installations\/\d+\/repositories$/.test(url.pathname)) return null;
	} else {
		return null;
	}
	return `${proxyOrigin}/https://${host}${url.pathname}${url.search}`;
}

export function githubUpstreamFetch(proxyOrigin: string | undefined, inner: typeof fetch = fetch): typeof fetch {
	if (!proxyOrigin) return inner;
	return (input, init) => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const rewritten = rewriteGitHubUrl(raw, proxyOrigin);
		return inner(rewritten ?? input, init);
	};
}
