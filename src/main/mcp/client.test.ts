import { describe, expect, test } from "bun:test";
import { parseKeyValueLines, qualifyToolName, splitCommand } from "../../shared/mcp";
import { McpClient } from "./client";
import { resultText, toParameterSchema, type JsonRpcRequest } from "./protocol";
import type { McpTransport } from "./transport";

/** A transport the test drives by hand, standing in for a real server. */
class FakeTransport implements McpTransport {
	sent: Array<JsonRpcRequest | { method: string }> = [];
	private messageListener: ((message: unknown) => void) | null = null;
	private closeListener: ((reason: string) => void) | null = null;
	closed = false;
	/** Set to make `send` fail the way an exited process does. */
	sendError: string | null = null;

	async send(message: JsonRpcRequest | { method: string }): Promise<void> {
		if (this.sendError) throw new Error(this.sendError);
		this.sent.push(message);
	}
	onMessage(listener: (message: unknown) => void): void {
		this.messageListener = listener;
	}
	onClose(listener: (reason: string) => void): void {
		this.closeListener = listener;
	}
	close(): void {
		this.closed = true;
	}
	/** Answer the nth request the client made. */
	reply(id: number, result: unknown): void {
		this.messageListener?.({ jsonrpc: "2.0", id, result });
	}
	replyError(id: number, message: string): void {
		this.messageListener?.({ jsonrpc: "2.0", id, error: { code: -32000, message } });
	}
	drop(reason: string): void {
		this.closeListener?.(reason);
	}
}

describe("MCP client", () => {
	test("the handshake initializes and then announces it, in that order", async () => {
		const transport = new FakeTransport();
		const client = new McpClient(transport);

		const connected = client.connect("NekoCode Desktop");
		transport.reply(1, { protocolVersion: "2025-06-18", capabilities: {} });
		await connected;

		expect(transport.sent).toHaveLength(2);
		expect((transport.sent[0] as JsonRpcRequest).method).toBe("initialize");
		// Required by the spec before any other call; servers reject tools/list
		// until they have seen it.
		expect(transport.sent[1].method).toBe("notifications/initialized");
	});

	test("replies are matched to their own request, whatever order they arrive in", async () => {
		const transport = new FakeTransport();
		const client = new McpClient(transport);

		const first = client.callTool("slow", {});
		const second = client.callTool("fast", {});
		// Out of order on purpose: correlation is by id, not by arrival.
		transport.reply(2, { content: [{ type: "text", text: "second" }] });
		transport.reply(1, { content: [{ type: "text", text: "first" }] });

		expect(resultText(await first)).toBe("first");
		expect(resultText(await second)).toBe("second");
	});

	test("a server error becomes a rejection rather than an empty result", async () => {
		const transport = new FakeTransport();
		const client = new McpClient(transport);

		const call = client.callTool("broken", {});
		transport.replyError(1, "no such issue");

		expect(call).rejects.toThrow("no such issue");
	});

	test("losing the transport rejects everything still in flight", async () => {
		const transport = new FakeTransport();
		const client = new McpClient(transport);
		const call = client.callTool("anything", {});

		transport.drop("服务器进程退出（code 1）");

		// The agent awaits a tool call unconditionally: one promise that never
		// settles would wedge the run and take the stop button with it.
		expect(call).rejects.toThrow("服务器进程退出");
		expect(client.callTool("later", {})).rejects.toThrow("服务器进程退出");
	});

	test("aborting stops the wait even though MCP cannot cancel the call", async () => {
		const transport = new FakeTransport();
		const client = new McpClient(transport);
		const controller = new AbortController();

		const call = client.callTool("slow", {}, controller.signal);
		controller.abort();

		expect(call).rejects.toThrow("Tool call cancelled");
	});

	test("a send that fails does not leave the call pending", async () => {
		const transport = new FakeTransport();
		transport.sendError = "MCP 服务器已断开";
		const client = new McpClient(transport);

		expect(client.callTool("anything", {})).rejects.toThrow("MCP 服务器已断开");
	});

	test("closing tears down the transport and refuses further calls", async () => {
		const transport = new FakeTransport();
		const client = new McpClient(transport);

		client.close();

		expect(transport.closed).toBe(true);
		expect(client.callTool("anything", {})).rejects.toThrow("已关闭");
	});
});

describe("MCP protocol helpers", () => {
	test("text content is joined and other content is named, not inlined", () => {
		expect(
			resultText({
				content: [
					{ type: "text", text: "line one" },
					{ type: "image", data: "…megabytes of base64…" },
					{ type: "text", text: "line two" },
				],
			}),
		).toBe("line one\n[image]\nline two");
	});

	test("a usable input schema passes through unchanged", () => {
		const schema = {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		};
		expect(toParameterSchema(schema)).toEqual(schema);
	});

	test("a missing or non-object schema becomes a callable no-argument tool", () => {
		const empty = { type: "object", properties: {} };
		expect(toParameterSchema(undefined)).toEqual(empty);
		expect(toParameterSchema({ type: "string" })).toEqual(empty);
		expect(toParameterSchema([1, 2])).toEqual(empty);
		// An object schema with no properties declared is still an object schema.
		expect(toParameterSchema({ type: "object" })).toEqual(empty);
	});
});

describe("MCP configuration parsing", () => {
	test("a pasted command line splits the way a shell would", () => {
		expect(splitCommand('npx -y @scope/server --root "/my files"')).toEqual({
			command: "npx",
			args: ["-y", "@scope/server", "--root", "/my files"],
		});
		expect(splitCommand("   ")).toEqual({ command: "", args: [] });
	});

	test("key=value lines keep everything after the first separator", () => {
		expect(
			parseKeyValueLines("# comment\nTOKEN=abc=def==\n\n  API_URL = https://x.test  \nbroken"),
		).toEqual({ TOKEN: "abc=def==", API_URL: "https://x.test" });
	});

	test("tool names are namespaced so two servers can both offer a search", () => {
		expect(qualifyToolName("linear", "search")).toBe("mcp__linear__search");
		expect(qualifyToolName("my server!", "search")).toBe("mcp__my_server___search");
	});
});
