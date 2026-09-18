import { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

/**
 * Routes the main process's outgoing requests through a proxy.
 *
 * The agent core reaches model providers with the runtime's own `fetch`, which
 * — unlike the browser windows — ignores the operating system's proxy settings
 * entirely. On a network where a provider is only reachable through a proxy
 * that means every request fails at the transport layer, with no hint that a
 * proxy was even involved. Pointing the global dispatcher at one fixes it for
 * every provider at once, without each of them having to know about it.
 */

/** Proxy URL forms the dispatcher understands. */
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

export interface ProxyResolution {
	url?: string;
	/** Where the setting came from, for the log line and the settings UI. */
	source: "manual" | "environment" | "system" | "none";
	/** Set when a candidate was found but could not be used. */
	warning?: string;
}

/**
 * Normalize a proxy candidate to a URL the dispatcher accepts.
 *
 * A bare `host:port` is accepted because that is how proxy clients and the
 * Windows proxy settings present one.
 */
export function normalizeProxyUrl(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return undefined;
	}
	if (!SUPPORTED_PROTOCOLS.has(url.protocol) || !url.hostname) return undefined;
	return url.toString();
}

/** Hosts `NO_PROXY` exempts. Matches the de facto curl/requests behaviour. */
export function isProxyExempt(host: string, noProxy: string | undefined): boolean {
	if (!noProxy) return false;
	const target = host.trim().toLowerCase();
	for (const raw of noProxy.split(",")) {
		const entry = raw.trim().toLowerCase().replace(/^\*?\./, "");
		if (!entry) continue;
		if (entry === "*") return true;
		if (target === entry || target.endsWith(`.${entry}`)) return true;
	}
	return false;
}

/**
 * The proxy the environment asks for, if any. `ALL_PROXY` is read last so a
 * protocol-specific variable wins, matching every other tool that reads these.
 */
export function proxyFromEnvironment(
	env: Record<string, string | undefined>,
	targetHost: string,
): string | undefined {
	if (isProxyExempt(targetHost, env.NO_PROXY ?? env.no_proxy)) return undefined;
	const candidates = [
		env.HTTPS_PROXY ?? env.https_proxy,
		env.HTTP_PROXY ?? env.http_proxy,
		env.ALL_PROXY ?? env.all_proxy,
	];
	for (const candidate of candidates) {
		const normalized = candidate ? normalizeProxyUrl(candidate) : undefined;
		if (normalized) return normalized;
	}
	return undefined;
}

/**
 * Read a proxy out of Chromium's resolution for a URL, e.g.
 * `PROXY 127.0.0.1:7890; DIRECT` or `DIRECT`. SOCKS entries are reported rather
 * than used: the dispatcher speaks HTTP CONNECT only, and silently ignoring a
 * configured SOCKS proxy would look exactly like having no proxy at all.
 */
export function parseSystemProxyRules(rules: string): ProxyResolution {
	let sawSocks = false;
	for (const raw of rules.split(";")) {
		const entry = raw.trim();
		if (!entry || /^DIRECT$/i.test(entry)) continue;
		const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/i.exec(entry);
		if (!match) continue;
		const [, scheme, address] = match as unknown as [string, string, string];
		if (/^SOCKS/i.test(scheme)) {
			sawSocks = true;
			continue;
		}
		const url = normalizeProxyUrl(/^HTTPS$/i.test(scheme) ? `https://${address}` : address);
		if (url) return { url, source: "system" };
	}
	return sawSocks
		? {
				source: "none",
				warning: "系统代理是 SOCKS 类型，应用无法使用；请在设置中手动填写 HTTP 代理地址。",
			}
		: { source: "none" };
}

/** Resolves the proxy to use, in precedence order. */
export async function resolveProxy(options: {
	manual?: string;
	env: Record<string, string | undefined>;
	targetUrl: string;
	/** Chromium's proxy resolution, injected so this stays testable. */
	resolveSystemProxy?: (url: string) => Promise<string>;
}): Promise<ProxyResolution> {
	if (options.manual !== undefined) {
		const url = normalizeProxyUrl(options.manual);
		if (url) return { url, source: "manual" };
		if (options.manual.trim()) {
			return { source: "none", warning: `无法识别的代理地址：${options.manual}` };
		}
		// An explicitly emptied setting means "no proxy", not "go look for one".
		return { source: "none" };
	}

	const host = new URL(options.targetUrl).hostname;
	const fromEnv = proxyFromEnvironment(options.env, host);
	if (fromEnv) return { url: fromEnv, source: "environment" };

	if (!options.resolveSystemProxy) return { source: "none" };
	try {
		return parseSystemProxyRules(await options.resolveSystemProxy(options.targetUrl));
	} catch {
		return { source: "none" };
	}
}

let directDispatcher: Dispatcher | undefined;

/**
 * Point the runtime's `fetch` at `url`, or back at a direct connection.
 *
 * The very first dispatcher is kept so turning a proxy off restores exactly
 * what the runtime started with instead of a newly built one.
 */
export function applyProxy(url: string | undefined): void {
	directDispatcher ??= getGlobalDispatcher();
	setGlobalDispatcher(url ? new ProxyAgent(url) : directDispatcher);
}
