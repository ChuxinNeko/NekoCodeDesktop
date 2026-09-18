import { request as httpRequest } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { connect as http2Connect } from "node:http2";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { FetchLike } from "./antigravity";

const HOSTS = new Set([
	"oauth2.googleapis.com", "www.googleapis.com", "cloudcode-pa.googleapis.com",
	"daily-cloudcode-pa.googleapis.com",
	"antigravity-hub-auto-updater-974169037036.us-central1.run.app",
]);

/**
 * Auth uses normal HTTP/2 negotiation like the reference auth HTTP client;
 * refresh and model generation use HTTP/1.1 without ALPN like its executor.
 * No browser headers, generic SDK headers,
 * automatic redirects, retries, or shared credential connection pools.
 * Node/OpenSSL's TLS ClientHello is not identical to Go's crypto/tls.
 */
export function createAntigravityFetch(resolveProxy: (url: string) => Promise<string | undefined>): FetchLike {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.port || url.username || url.password) {
			throw new Error("Unsupported Antigravity endpoint");
		}
		const signal = init?.signal ?? undefined;
		signal?.throwIfAborted();
		const proxyUrl = await resolveProxy(url.href);
		signal?.throwIfAborted();
		const body = init?.body instanceof URLSearchParams ? init.body.toString() : init?.body;
		if (body != null && typeof body !== "string") throw new Error("Unsupported Antigravity request body");
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		if (body != null) headers["content-length"] = String(Buffer.byteLength(body));
		// Go's Transport adds gzip only when the caller has not selected encoding.
		headers["accept-encoding"] ??= "gzip";
		const refresh = (url.pathname === "/token" && typeof body === "string" && new URLSearchParams(body).get("grant_type") === "refresh_token") || ["/v1internal:generateContent", "/v1internal:streamGenerateContent", "/v1internal:countTokens"].includes(url.pathname);
		const agent = new Agent({ keepAlive: true, ALPNProtocols: [], maxCachedSessions: 0 });
		let tunnel: import("node:stream").Duplex | undefined;
		let tls: TLSSocket | undefined;
		try {
			if (proxyUrl) {
				const proxy = new URL(proxyUrl);
				if (!["http:", "https:"].includes(proxy.protocol)) throw new Error("Unsupported proxy protocol");
				tunnel = await new Promise<import("node:stream").Duplex>((resolve, reject) => {
					const request = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
						hostname: proxy.hostname, port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
						method: "CONNECT", path: `${url.hostname}:443`, signal,
						headers: {
							Host: `${url.hostname}:443`,
							...(proxy.username ? { "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {}),
						},
					});
					request.once("error", reject);
					request.once("connect", (response, tunnel, head) => {
						if (response.statusCode !== 200) { tunnel.destroy(); reject(new Error(`Proxy CONNECT failed (${response.statusCode})`)); return; }
						if (head.length) tunnel.unshift(head);
						resolve(tunnel);
					});
					request.end();
				});
				if (signal?.aborted) { tunnel.destroy(); signal.throwIfAborted(); }
			}
			const socket = tlsConnect({ host: url.hostname, port: 443, socket: tunnel, servername: url.hostname, ALPNProtocols: refresh ? [] : ["h2", "http/1.1"] }) as TLSSocket;
			tls = socket;
			await new Promise<void>((resolve, reject) => {
				const abort = () => socket.destroy(new Error("Antigravity request aborted"));
				signal?.addEventListener("abort", abort, { once: true });
				const clean = () => signal?.removeEventListener("abort", abort);
				socket.once("error", (error) => { clean(); reject(error); });
				socket.once("secureConnect", () => { clean(); resolve(); });
				if (signal?.aborted) abort();
			});
			if (socket.alpnProtocol === "h2") {
				if (headers["user-agent"] === "Go-http-client/1.1") headers["user-agent"] = "Go-http-client/2.0";
				return await new Promise<Response>((resolve, reject) => {
					const session = http2Connect(url.origin, { createConnection: () => socket });
					const stream = session.request({ ":method": init?.method ?? "GET", ":path": url.pathname + url.search, ...headers }, { signal });
					session.once("error", reject);
					stream.once("error", reject);
					stream.once("close", () => session.destroy());
					stream.once("response", (received) => {
						const responseHeaders = new Headers();
						for (const [name, value] of Object.entries(received)) {
							if (!name.startsWith(":") && value !== undefined) responseHeaders.set(name, String(value));
						}
						const source = received["content-encoding"] === "gzip" ? stream.pipe(createGunzip()) : stream;
						stream.on("error", (error) => { if (source !== stream) source.destroy(error); });
						source.once("close", () => session.destroy());
						const status = Number(received[":status"] ?? 502);
						if ([204, 304].includes(status)) { stream.resume(); resolve(new Response(null, { status, headers: responseHeaders })); }
						else resolve(new Response(Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
					});
					stream.end(body ?? undefined);
				});
			}
			agent.createConnection = () => socket;
			return await new Promise<Response>((resolve, reject) => {
				const request = httpsRequest(url, { method: init?.method ?? "GET", headers, agent, signal }, (response) => {
					const responseHeaders = new Headers();
					for (const [name, value] of Object.entries(response.headers)) {
						if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
					}
					const source = response.headers["content-encoding"] === "gzip" ? response.pipe(createGunzip()) : response;
					response.on("error", (error) => source.destroy(error));
					// Destroy only after the body has been consumed, without a Connection: close header.
					source.once("close", () => agent.destroy());
					const status = response.statusCode ?? 502;
					if ([204, 304].includes(status)) {
						response.resume();
						resolve(new Response(null, { status, headers: responseHeaders }));
					} else {
						resolve(new Response(Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
					}
				});
				request.removeHeader("Connection");
				request.once("error", reject);
				request.end(body ?? undefined);
			});
		} catch (error) {
			tls?.destroy();
			tunnel?.destroy();
			agent.destroy();
			throw error;
		}
	}) as FetchLike;
}
