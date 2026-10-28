import type { ProxyStatus } from "../shared/settings";

// The desktop uses the standard Fetch API, without Bun's preconnect extension.
export type GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface GitHubNetworkSession {
	setProxy(config: { mode: "system" | "direct" | "fixed_servers"; proxyRules?: string }): Promise<void>;
	fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

/** Use Chromium's per-URL system proxy resolution, not the model API's Node dispatcher. */
export function createGitHubFetch(options: {
	session: () => GitHubNetworkSession;
	proxy: () => ProxyStatus;
}): GitHubFetch {
	return async (input, init) => {
		const network = options.session();
		const proxy = options.proxy();
		if (proxy.url && (proxy.source === "manual" || proxy.source === "environment")) {
			await network.setProxy({ mode: "fixed_servers", proxyRules: proxy.url });
		} else {
			// A manual empty setting explicitly requests direct access. Otherwise
			// let Chromium evaluate PAC/system rules for GitHub itself.
			await network.setProxy({ mode: proxy.manual !== null ? "direct" : "system" });
		}
		(init?.signal ?? (input instanceof Request ? input.signal : undefined))?.throwIfAborted();
		return network.fetch(input instanceof URL ? input.href : input, init);
	};
}
