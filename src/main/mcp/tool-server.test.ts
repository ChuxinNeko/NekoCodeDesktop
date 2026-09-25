import { afterEach, describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { McpToolServer, toMcpContent, toolDescription, type ToolServerHandle } from "./tool-server";

function tool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, "name" | "execute">): ToolDefinition {
	return {
		label: overrides.name,
		description: `${overrides.name} tool`,
		parameters: { type: "object", properties: { text: { type: "string" } }, required: [] } as never,
		...overrides,
	} as ToolDefinition;
}

let server: McpToolServer;
afterEach(() => server?.close());

async function rpc(handle: ToolServerHandle, method: string, params?: unknown, init: { headers?: Record<string, string>; id?: number | null } = {}) {
	const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
	for (const header of handle.headers) headers[header.name] ??= header.value;
	const id = init.id === undefined ? 1 : init.id;
	const response = await fetch(handle.url, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
	});
	const text = await response.text();
	return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

describe("McpToolServer", () => {
	test("answers the MCP handshake and lists the registered tools", async () => {
		server = new McpToolServer({ version: "1.2.3" });
		const handle = await server.register({
			tools: () => [tool({ name: "echo", promptGuidelines: ["Use sparingly."], execute: async () => ({ content: [], details: {} }) })],
		});
		expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		const init = await rpc(handle, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t" } });
		expect(init.body?.result).toMatchObject({
			protocolVersion: "2025-03-26",
			capabilities: { tools: {} },
			serverInfo: { name: "nekocode", version: "1.2.3" },
		});
		expect((await rpc(handle, "notifications/initialized", undefined, { id: null })).status).toBe(202);
		const list = await rpc(handle, "tools/list");
		expect(list.body?.result.tools).toEqual([
			{
				name: "echo",
				title: "echo",
				description: "echo tool\n\n- Use sparingly.",
				inputSchema: { type: "object", properties: { text: { type: "string" } }, required: [] },
			},
		]);
	});

	test("calls a tool with validated arguments and returns text and images", async () => {
		const seen: unknown[] = [];
		server = new McpToolServer({
			version: "0",
			validate: (_tool, args) => ({ ...args, validated: true }),
		});
		const handle = await server.register({
			tools: () => [
				tool({
					name: "shot",
					execute: async (_id, params) => {
						seen.push(params);
						return {
							content: [
								{ type: "text", text: "captured" },
								{ type: "image", data: "AAAA", mimeType: "image/png" },
							],
							details: { big: "not sent" },
						};
					},
				}),
			],
		});
		const call = await rpc(handle, "tools/call", { name: "shot", arguments: { text: "hi" } });
		expect(call.body?.result).toEqual({
			content: [
				{ type: "text", text: "captured" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
		});
		expect(seen).toEqual([{ text: "hi", validated: true }]);
	});

	test("a failing tool or bad arguments come back as an error result the model can read", async () => {
		server = new McpToolServer({
			version: "0",
			validate: (_tool, args) => {
				if (args.text === 1) throw new Error("text: expected string");
				return args;
			},
		});
		const handle = await server.register({
			tools: () => [tool({ name: "boom", execute: async () => { throw new Error("No page is bound"); } })],
		});
		expect((await rpc(handle, "tools/call", { name: "boom", arguments: {} })).body?.result).toEqual({
			content: [{ type: "text", text: "No page is bound" }],
			isError: true,
		});
		expect((await rpc(handle, "tools/call", { name: "boom", arguments: { text: 1 } })).body?.result).toMatchObject({
			isError: true,
			content: [{ text: "text: expected string" }],
		});
		expect((await rpc(handle, "tools/call", { name: "missing" })).body?.error).toMatchObject({ code: -32602 });
		expect((await rpc(handle, "resources/list")).body?.error).toMatchObject({ code: -32601 });
	});

	test("a tool switched off after listing can no longer be called", async () => {
		let enabled = true;
		server = new McpToolServer({ version: "0" });
		const handle = await server.register({
			tools: () => (enabled ? [tool({ name: "computer_click", execute: async () => ({ content: [], details: {} }) })] : []),
		});
		expect((await rpc(handle, "tools/list")).body?.result.tools).toHaveLength(1);
		enabled = false;
		expect((await rpc(handle, "tools/call", { name: "computer_click" })).body?.error?.message).toContain("Unknown tool");
	});

	test("refuses requests without the token, with another token, or from a web page", async () => {
		server = new McpToolServer({ version: "0" });
		const handle = await server.register({ tools: () => [] });
		expect((await rpc(handle, "tools/list", undefined, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
		expect((await rpc(handle, "tools/list", undefined, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
		const other = await server.register({ tools: () => [] });
		other.dispose();
		expect((await rpc(other, "tools/list")).status).toBe(401);
		expect((await fetch(handle.url, { headers: { Authorization: handle.headers[0].value } })).status).toBe(405);
	});

	test("sequential tools wait for each other; others do not", async () => {
		const order: string[] = [];
		const slow = (name: string, executionMode?: "sequential") =>
			tool({
				name,
				executionMode,
				execute: async () => {
					order.push(`${name}:start`);
					await new Promise((resolve) => setTimeout(resolve, 60));
					order.push(`${name}:end`);
					return { content: [{ type: "text", text: name }], details: {} };
				},
			});
		server = new McpToolServer({ version: "0" });
		const handle = await server.register({ tools: () => [slow("a", "sequential"), slow("b", "sequential")] });
		await Promise.all([rpc(handle, "tools/call", { name: "a" }, { id: 1 }), rpc(handle, "tools/call", { name: "b" }, { id: 2 })]);
		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
	});

	test("notifications/cancelled aborts the running call", async () => {
		let aborted = false;
		server = new McpToolServer({ version: "0" });
		const handle = await server.register({
			tools: () => [
				tool({
					name: "wait",
					execute: (_id, _params, signal) =>
						new Promise((_resolve, reject) => {
							signal?.addEventListener("abort", () => {
								aborted = true;
								reject(new Error("Tool call cancelled"));
							});
						}),
				}),
			],
		});
		const call = rpc(handle, "tools/call", { name: "wait" }, { id: 7 });
		await new Promise((resolve) => setTimeout(resolve, 30));
		await rpc(handle, "notifications/cancelled", { requestId: 7 }, { id: null });
		expect((await call).body?.result).toMatchObject({ isError: true, content: [{ text: "Tool call cancelled" }] });
		expect(aborted).toBe(true);
	});
});

describe("tool result mapping", () => {
	test("keeps text and images and drops what MCP cannot carry", () => {
		expect(
			toMcpContent([{ type: "text", text: "a" }, { type: "image", data: "b", mimeType: "image/png" }, { type: "thinking", thinking: "x" }, null]),
		).toEqual([
			{ type: "text", text: "a" },
			{ type: "image", data: "b", mimeType: "image/png" },
		]);
		expect(toolDescription({ description: "d" } as ToolDefinition)).toBe("d");
	});
});
