import type { ProxyStatus } from "../shared/settings";

interface UpdateNetworkSession {
	setProxy(config: { mode: "system" | "direct" | "fixed_servers"; proxyRules?: string }): Promise<void>;
	fetch(url: string, init: RequestInit): Promise<Response>;
}

/** Use Chromium's per-URL system proxy resolution, not the model API's Node dispatcher. */
export function createUpdateFetch(options: {
	session: () => UpdateNetworkSession;
	proxy: () => ProxyStatus;
}): (url: string, init: RequestInit) => Promise<Response> {
	return async (url, init) => {
		const network = options.session();
		const proxy = options.proxy();
		if (proxy.url && (proxy.source === "manual" || proxy.source === "environment")) {
			await network.setProxy({ mode: "fixed_servers", proxyRules: proxy.url });
		} else {
			// A manual empty setting explicitly requests direct access. Otherwise
			// let Chromium evaluate PAC/system rules for GitHub itself.
			await network.setProxy({ mode: proxy.manual !== null ? "direct" : "system" });
		}
		init.signal?.throwIfAborted();
		return network.fetch(url, init);
	};
}
