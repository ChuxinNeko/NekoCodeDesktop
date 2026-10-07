import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { McpAuthStore } from "../../../src/main/mcp/oauth";
import { McpService } from "../../../src/main/mcp/service";

const encryption = {
	isEncryptionAvailable: () => true,
	getSelectedStorageBackend: () => "gnome_libsecret" as const,
	encryptString: (text: string) => Buffer.from(`enc:${text}`, "utf8"),
	decryptString: (buffer: Buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
};

const directories: string[] = [];
const services: McpService[] = [];

afterEach(() => {
	for (const service of services.splice(0)) service.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function userData(): string {
	const directory = mkdtempSync(join(tmpdir(), "neko-mcp-desktop-"));
	directories.push(directory);
	return directory;
}

function fakeDesktopBridgeServer(server: InMemoryTransport): void {
	const reply = (id: unknown, result: unknown) => void server.send({ jsonrpc: "2.0", id, result } as never);
	server.onMessage((message) => {
		const request = message as { id?: unknown; method: string; params?: Record<string, unknown> };
		if (request.id === undefined) return;
		if (request.method === "initialize") {
			reply(request.id, {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "desktop-bridge", version: "0.1.0" },
			});
		} else if (request.method === "tools/list") {
			reply(request.id, {
				tools: [
					{ name: "session_status", description: "status", inputSchema: { type: "object" } },
					{ name: "desktop_screenshot", description: "shot", inputSchema: { type: "object" } },
				],
			});
		}
	});
	void server.start();
}

describe("MCP desktop integration in McpService", () => {
	test("discovers desktop capability and issues single-use viewer ticket", async () => {
		const auth = new McpAuthStore(userData(), encryption);
		// Pre-populate simulated OAuth sign-in state
		auth.save("http://localhost:8080/mcp", {
			serverUrl: "http://localhost:8080/mcp",
			clientInformation: { client_id: "test-client" },
			tokens: {
				access_token: "test-access-token-12345",
				refresh_token: "test-refresh-token",
				token_type: "Bearer",
			},
			discovery: {
				authorizationServerUrl: "http://localhost:8080",
				resourceMetadata: {
					resource: "http://localhost:8080/mcp",
					desktop_viewer: {
						viewer_url: "http://localhost:8080/viewer",
						ticket_endpoint: "http://localhost:8080/api/viewer/ticket",
						read_only: true,
					},
				},
			},
		});

		let ticketRequestHeaders: HeadersInit | undefined;
		const desktopFetch = (async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			if (url === "http://localhost:8080/api/viewer/ticket") {
				ticketRequestHeaders = init?.headers;
				return new Response(
					JSON.stringify({
						viewer_url: "http://localhost:8080/viewer#ticket=ValidTicket_1234567890123456789012",
						ticket_expires_in: 59,
						read_only: true,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("Not found", { status: 404 });
		}) as unknown as typeof globalThis.fetch;

		const service = new McpService(userData(), () => process.cwd(), () => undefined, {
			auth,
			openUrl: () => undefined,
			desktopFetch,
			createTransport: async () => {
				const { client, server } = createInMemoryTransportPair();
				fakeDesktopBridgeServer(server);
				return client;
			},
		});
		services.push(service);

		const snapshot = await service.save({
			name: "bridge",
			transport: "http",
			url: "http://localhost:8080/mcp",
			enabled: true,
		});

		const serverStatus = snapshot.servers.find((s) => s.config.name === "bridge");
		expect(serverStatus?.state).toBe("ready");
		expect(serverStatus?.desktopViewer?.url).toBe("http://localhost:8080/viewer");
		expect(serverStatus?.desktopViewer?.readOnly).toBe(true);

		// Open desktop through main process method
		const connection = await service.openDesktop(serverStatus!.config.id);
		expect(connection.serverId).toBe(serverStatus!.config.id);
		expect(connection.viewerUrl).toBe("http://localhost:8080/viewer#ticket=ValidTicket_1234567890123456789012");
		expect(connection.partition).toBe(serverStatus!.desktopViewer!.partition);

		// Token was sent securely via Bearer header
		const authHeader = (ticketRequestHeaders as Record<string, string>)?.["Authorization"];
		expect(authHeader).toBe("Bearer test-access-token-12345");
	});

	test("rejects opening desktop if server is not signed in or not ready", async () => {
		const auth = new McpAuthStore(userData(), encryption);
		const service = new McpService(userData(), () => process.cwd(), () => undefined, {
			auth,
			createTransport: async () => {
				const { client, server } = createInMemoryTransportPair();
				fakeDesktopBridgeServer(server);
				return client;
			},
		});
		services.push(service);

		const snapshot = await service.save({
			name: "bridge-unauthenticated",
			transport: "http",
			url: "http://localhost:8080/mcp",
			enabled: true,
		});

		const serverId = snapshot.servers[0].config.id;
		// Not signed in -> rejected
		expect(service.openDesktop(serverId)).rejects.toThrow("MCP 桌面不可用");
	});
});
