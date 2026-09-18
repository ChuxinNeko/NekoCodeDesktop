import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { createAntigravityFetch } from "./antigravity-transport";

test("Antigravity transport rejects non-provider URLs before connecting", async () => {
	let resolved = false;
	const fetch = createAntigravityFetch(async () => { resolved = true; return undefined; });
	await expect(fetch("https://untrusted.example/token")).rejects.toThrow("Unsupported");
	await expect(fetch("http://oauth2.googleapis.com/token")).rejects.toThrow("Unsupported");
	expect(resolved).toBe(false);
});

for (const mode of ["refresh", "oauth", "generate"] as const) test(`proxy CONNECT negotiates the reference TLS mode for ${mode}, without automatic retries`, async () => {
	const refresh = mode !== "oauth";
	const host = mode === "generate" ? "daily-cloudcode-pa.googleapis.com" : "oauth2.googleapis.com";
	let connections = 0;
	let connectHeader = "";
	let hello = Buffer.alloc(0);
	const proxy = createServer((socket) => {
		connections++;
		let connected = false;
		socket.on("data", (chunk) => {
			if (!connected) {
				connectHeader += chunk.toString();
				if (!connectHeader.includes("\r\n\r\n")) return;
				connected = true; socket.write("HTTP/1.1 200 Connection established\r\n\r\n"); return;
			}
			hello = Buffer.concat([hello, chunk]);
			if (hello.length >= 5 && hello.length >= 5 + hello.readUInt16BE(3)) socket.destroy();
		});
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const port = (proxy.address() as import("node:net").AddressInfo).port;
	try {
		const fetch = createAntigravityFetch(async () => `http://127.0.0.1:${port}`);
		await expect(fetch(`https://${host}${mode === "generate" ? "/v1internal:streamGenerateContent?alt=sse" : "/token"}`, { method: "POST", body: `grant_type=${refresh ? "refresh_token" : "authorization_code"}`, signal: AbortSignal.timeout(3000) })).rejects.toThrow();
		expect(connections).toBe(1);
		expect(connectHeader).toContain(`CONNECT ${host}:443 HTTP/1.1`);
		expect(hello[0]).toBe(22); // TLS handshake record.
		expect(hello[5]).toBe(1); // ClientHello.
		let offset = 5 + 4 + 2 + 32;
		offset += 1 + hello[offset]!; // Session ID.
		offset += 2 + hello.readUInt16BE(offset); // Cipher suites.
		offset += 1 + hello[offset]!; // Compression methods.
		const end = offset + 2 + hello.readUInt16BE(offset);
		offset += 2;
		const extensions: number[] = [];
		while (offset < end) {
			extensions.push(hello.readUInt16BE(offset));
			offset += 4 + hello.readUInt16BE(offset + 2);
		}
		if (refresh) expect(extensions).not.toContain(16);
		else expect(extensions).toContain(16);
	} finally { await new Promise<void>((resolve) => proxy.close(() => resolve())); }
});
