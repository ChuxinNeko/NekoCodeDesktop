import { createServer, type Server } from "node:http";

/**
 * The loopback server an OAuth provider redirects back to.
 *
 * The redirect URI is registered with the provider, so the port and path are
 * fixed and the browser is the only thing that talks to it. Both loopback
 * families are bound: the redirect names `localhost`, and which of `::1` and
 * `127.0.0.1` a browser resolves that to differs by machine — binding one and
 * guessing wrong looks exactly like a hung sign-in.
 */
export interface CallbackServer {
	readonly port: number;
	/** Resolves with the code, or null if the wait was cancelled. */
	waitForCode(): Promise<string | null>;
	/** Hand in a code or redirect URL pasted by the user instead. */
	submit(input: string): void;
	cancel(): void;
	close(): void;
}

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>授权已接收</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>授权已接收</h2><p>请回到 NekoCode 查看登录结果，可以关闭此页面。</p></div>`;

function errorHtml(reason: string): string {
	reason = reason.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
	return `<!doctype html><meta charset="utf-8"><title>登录失败</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>登录失败</h2><p>${reason}</p></div>`;
}

/**
 * Read a code out of whatever the user pasted: the whole redirect URL, a
 * query string, or the bare code.
 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string; error?: string } {
	const value = input.trim();
	if (!value) return {};
	let candidate = value;
	if (!candidate.includes("://")) {
		if (candidate.startsWith("?")) candidate = `http://localhost/${candidate}`;
		else if (/[/?#:]/.test(candidate)) candidate = `http://${candidate}`;
		else if (candidate.includes("=")) candidate = `http://localhost/?${candidate}`;
		else throw new Error("请粘贴包含 code 和 state 的完整回调地址");
	}
	const url = new URL(candidate);
	const fragment = new URLSearchParams(url.hash.slice(1));
	const get = (name: string) => (url.searchParams.get(name) || fragment.get(name) || "").trim();
	let code = get("code");
	let state = get("state");
	if (code.includes("#") && !state) [code, state] = code.split("#", 2) as [string, string];
	return { code, state, error: get("error") || get("error_description") };
}

export async function startCallbackServer(options: {
	port: number;
	path: string;
	/** Rejects a callback that did not come from the sign-in we started. */
	state: string;
}): Promise<CallbackServer> {
	let settle: ((value: string | null) => void) | undefined;
	const waited = new Promise<string | null>((resolve) => {
		let settled = false;
		settle = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	const server = createServer((req, res) => {
		const respond = (status: number, html: string) => {
			res.statusCode = status;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(html);
		};
		try {
			if (req.method !== "GET") { respond(405, errorHtml("不支持的请求方法。")); return; }
			const url = new URL(req.url ?? "", "http://localhost");
			if (url.pathname !== options.path) {
				respond(404, errorHtml("回调地址不正确。"));
				return;
			}
			if (url.searchParams.get("state") !== options.state) {
				respond(400, errorHtml("状态校验失败，请重新登录。"));
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				respond(400, errorHtml(`授权被拒绝：${error}`));
				settle?.(null);
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				respond(400, errorHtml("回调中没有授权码。"));
				return;
			}
			respond(200, SUCCESS_HTML);
			settle?.(code);
		} catch {
			respond(500, errorHtml("处理回调时出错。"));
		}
	});

	// A second listener for the other loopback family. Failing to get it is not
	// fatal — the first one usually is the one the browser reaches.
	const secondary = createServer((req, res) => server.emit("request", req, res));

	let boundPort = options.port;
	let occupied = false;
	const listen = (target: Server, host: string) =>
		new Promise<boolean>((resolve) => {
			const onError = (error: NodeJS.ErrnoException) => { occupied ||= error.code === "EADDRINUSE"; resolve(false); };
			target.once("error", onError);
			target.listen(boundPort, host, () => {
				target.off("error", onError);
				boundPort = (target.address() as import("node:net").AddressInfo).port;
				resolve(true);
			});
		});

	const boundV4 = await listen(server, "127.0.0.1");
	const boundV6 = await listen(secondary, "::1");
	if (occupied || (!boundV4 && !boundV6)) {
		server.close(); secondary.close();
		throw new Error(`OAuth 回调端口 ${options.port} 不可用，请关闭占用该端口的程序后重试`);
	}

	return {
		port: boundPort,
		waitForCode: () => waited,
		submit: (input: string) => {
			const parsed = parseAuthorizationInput(input);
			if (parsed.state !== options.state) throw new Error("OAuth state 校验失败，请粘贴本次登录的完整回调地址");
			if (parsed.error) { settle?.(null); return; }
			if (!parsed.code) throw new Error("回调地址中没有授权码");
			if (parsed.code) settle?.(parsed.code);
		},
		cancel: () => settle?.(null),
		close: () => {
			settle?.(null);
			for (const target of [server, secondary]) {
				try {
					target.close();
				} catch {
					// already closed
				}
			}
		},
	};
}
