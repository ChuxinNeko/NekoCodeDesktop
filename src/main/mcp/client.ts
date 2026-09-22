import {
	isResponse,
	PROTOCOL_VERSION,
	type JsonRpcResponse,
	type McpCallToolResult,
	type McpListToolsResult,
	type McpToolDescriptor,
} from "./protocol";
import type { McpTransport } from "./transport";

/** A server that has not answered by now is not going to. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Connecting runs a process and a handshake; give it longer than one call. */
const CONNECT_TIMEOUT_MS = 60_000;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * One connected MCP server.
 *
 * Owns the request/response correlation and nothing else — transports decide
 * how bytes move, the service decides which servers exist. Every pending call
 * is rejected when the transport dies, because a tool call the agent is
 * awaiting would otherwise hang the whole run.
 */
export class McpClient {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private closedReason: string | null = null;

	constructor(private readonly transport: McpTransport) {
		transport.onMessage((message) => this.receive(message));
		transport.onClose((reason) => this.fail(reason));
	}

	private receive(message: unknown): void {
		if (!isResponse(message)) return; // A notification: nothing here waits on one.
		const response = message as JsonRpcResponse;
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		clearTimeout(pending.timer);
		if (response.error) pending.reject(new Error(response.error.message));
		else pending.resolve(response.result);
	}

	private fail(reason: string): void {
		this.closedReason = reason;
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
	}

	private request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
		if (this.closedReason) return Promise.reject(new Error(this.closedReason));
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} 超时（${String(Math.round(timeoutMs / 1000))}s）`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.transport.send({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	/**
	 * Handshake.
	 *
	 * The `initialized` notification is required before any other call: a
	 * spec-following server rejects `tools/list` until it has been sent.
	 */
	async connect(clientName: string): Promise<void> {
		await this.request(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: clientName, version: "1.0.0" },
			},
			CONNECT_TIMEOUT_MS,
		);
		await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	}

	async listTools(): Promise<McpToolDescriptor[]> {
		const result = (await this.request("tools/list")) as McpListToolsResult | null;
		return result?.tools ?? [];
	}

	async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallToolResult> {
		if (signal?.aborted) throw new Error("Tool call cancelled");
		const call = this.request("tools/call", { name, arguments: args ?? {} });
		if (!signal) return (await call) as McpCallToolResult;
		// The server keeps working either way — MCP has no cancel for a call in
		// flight — but the agent stops waiting, which is what the stop button means.
		return (await Promise.race([
			call,
			new Promise<never>((_, reject) => {
				signal.addEventListener("abort", () => reject(new Error("Tool call cancelled")), {
					once: true,
				});
			}),
		])) as McpCallToolResult;
	}

	close(): void {
		this.fail("MCP 服务器已关闭");
		this.transport.close();
	}
}
