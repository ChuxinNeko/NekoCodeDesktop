/**
 * NekoCode's own tools, served over MCP to agents that are not NekoLocal.
 *
 * An ACP agent attaches MCP servers when a session starts; this is the one it
 * is handed, so Computer Use, the browser panel and the rest run exactly as
 * they do for NekoLocal — the same `ToolDefinition`s, executed in this process
 * with direct access to the windows and drivers they need.
 *
 * Streamable HTTP, answered with plain JSON: no server-initiated messages are
 * needed, so there is no SSE stream. It listens on loopback only, each
 * registration has its own bearer token, and a request carrying an `Origin`
 * (i.e. from a web page, however it found the port) is refused.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MCP_PATH = "/mcp";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** Checks and coerces arguments the way NekoLocal's agent loop does before `execute`. */
export type ToolArgumentValidator = (tool: ToolDefinition, args: Record<string, unknown>) => Promise<unknown> | unknown;

export interface ToolServerRegistration {
	/** Resolved on every request, so a tool switched off mid-session is gone at once. */
	tools: () => ToolDefinition[];
}

export interface ToolServerHandle {
	url: string;
	headers: Array<{ name: string; value: string }>;
	dispose(): void;
}

interface Registration extends ToolServerRegistration {
	/** Tools marked `sequential` wait for each other, as they do in the agent loop. */
	queue: Promise<unknown>;
	inFlight: Map<string | number, AbortController>;
}

interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The description an agent sees: NekoLocal gets guidelines through its system prompt, an agent only through this. */
export function toolDescription(tool: ToolDefinition): string {
	const guidelines = tool.promptGuidelines?.filter(Boolean) ?? [];
	return guidelines.length === 0 ? tool.description : `${tool.description}\n\n${guidelines.map((line) => `- ${line}`).join("\n")}`;
}

/** A tool result in MCP's shape. Text and images carry over as they are. */
export function toMcpContent(content: unknown): ToolContent[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((item): ToolContent[] => {
		if (!isObject(item)) return [];
		if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }];
		if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
			return [{ type: "image", data: item.data, mimeType: item.mimeType }];
		}
		return [];
	});
}

export class McpToolServer {
	private server: Server | null = null;
	private listening: Promise<number> | null = null;
	private readonly registrations = new Map<string, Registration>();

	constructor(
		private readonly options: {
			version: string;
			validate?: ToolArgumentValidator;
		},
	) {}

	/** Start listening on first use; nothing is bound until an agent needs it. */
	private port(): Promise<number> {
		this.listening ??= new Promise<number>((resolve, reject) => {
			const server = createServer((request, response) => void this.handle(request, response));
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
			this.server = server;
		});
		return this.listening;
	}

	async register(registration: ToolServerRegistration): Promise<ToolServerHandle> {
		const port = await this.port();
		const token = randomBytes(32).toString("base64url");
		this.registrations.set(token, { ...registration, queue: Promise.resolve(), inFlight: new Map() });
		return {
			url: `http://127.0.0.1:${port}${MCP_PATH}`,
			headers: [{ name: "Authorization", value: `Bearer ${token}` }],
			dispose: () => {
				const entry = this.registrations.get(token);
				if (!entry) return;
				this.registrations.delete(token);
				for (const controller of entry.inFlight.values()) controller.abort();
			},
		};
	}

	close(): void {
		for (const entry of this.registrations.values()) {
			for (const controller of entry.inFlight.values()) controller.abort();
		}
		this.registrations.clear();
		this.server?.close();
		this.server = null;
		this.listening = null;
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const reply = (status: number, body?: unknown) => {
			if (response.headersSent) return;
			response.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
			response.end(body === undefined ? undefined : JSON.stringify(body));
		};
		// A browser page can reach loopback too; agents never send an Origin.
		if (request.headers.origin) return reply(403);
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== MCP_PATH) return reply(404);
		const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
		const registration = token ? this.registrations.get(token) : undefined;
		if (!registration) return reply(401);
		if (request.method === "DELETE") return reply(200);
		// No server-to-client stream: everything is answered in the POST.
		if (request.method !== "POST") return reply(405);

		let body: unknown;
		try {
			body = JSON.parse(await readBody(request));
		} catch (error) {
			return reply(error instanceof BodyTooLargeError ? 413 : 400, {
				jsonrpc: "2.0",
				id: null,
				error: { code: PARSE_ERROR, message: errorText(error) },
			});
		}
		const messages = Array.isArray(body) ? body : [body];
		// The call goes on while it is being answered; a client that hangs up
		// no longer wants the result.
		const aborts: AbortController[] = [];
		response.on("close", () => {
			if (!response.writableFinished) for (const controller of aborts) controller.abort();
		});
		const replies = (await Promise.all(messages.map((message) => this.dispatch(registration, message, aborts)))).filter(
			(entry) => entry !== null,
		);
		if (replies.length === 0) return reply(202);
		reply(200, Array.isArray(body) ? replies : replies[0]);
	}

	private async dispatch(registration: Registration, raw: unknown, aborts: AbortController[]): Promise<object | null> {
		if (!isObject(raw)) return { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Invalid request" } };
		const message = raw as JsonRpcMessage;
		const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
		const method = typeof message.method === "string" ? message.method : null;
		if (!method) return null; // a response to nothing we sent
		const params = isObject(message.params) ? message.params : {};
		const result = (value: unknown) => (id === null ? null : { jsonrpc: "2.0", id, result: value });
		const failure = (code: number, text: string) => (id === null ? null : { jsonrpc: "2.0", id, error: { code, message: text } });

		switch (method) {
			case "initialize": {
				const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
				return result({
					protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "nekocode", title: "NekoCode", version: this.options.version },
					instructions:
						"NekoCode's own tools: the browser panel in the NekoCode window and, when enabled in its settings, Computer Use on this desktop.",
				});
			}
			case "ping":
				return result({});
			case "tools/list":
				return result({
					tools: registration.tools().map((tool) => ({
						name: tool.name,
						title: tool.label || tool.name,
						description: toolDescription(tool),
						inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as unknown,
					})),
				});
			case "tools/call": {
				const name = typeof params.name === "string" ? params.name : "";
				const tool = registration.tools().find((entry) => entry.name === name);
				if (!tool) return failure(INVALID_PARAMS, `Unknown tool: ${name}`);
				const controller = new AbortController();
				aborts.push(controller);
				if (id !== null) registration.inFlight.set(id, controller);
				try {
					const args = isObject(params.arguments) ? params.arguments : {};
					return result(await this.call(registration, tool, args, controller.signal));
				} finally {
					if (id !== null) registration.inFlight.delete(id);
				}
			}
			case "notifications/cancelled": {
				const target = params.requestId;
				if (typeof target === "string" || typeof target === "number") registration.inFlight.get(target)?.abort();
				return null;
			}
			default:
				if (method.startsWith("notifications/")) return null;
				return failure(METHOD_NOT_FOUND, `Method not found: ${method}`);
		}
	}

	/**
	 * Run one tool the way the agent loop would. Failures are results, not RPC
	 * errors: MCP reports a tool that ran and failed with `isError`, which the
	 * model gets to read and react to.
	 */
	private async call(
		registration: Registration,
		tool: ToolDefinition,
		rawArgs: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ content: ToolContent[]; isError?: boolean }> {
		const run = async () => {
			try {
				const prepared = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
				const args = this.options.validate ? await this.options.validate(tool, prepared as Record<string, unknown>) : prepared;
				// Tools served here do not use the extension context; NekoLocal's own
				// session supplies the real one to the tools that do.
				const output = await tool.execute(`mcp-${randomBytes(6).toString("hex")}`, args as never, signal, undefined, {} as never);
				const content = toMcpContent(output.content);
				return { content: content.length > 0 ? content : [{ type: "text" as const, text: "(no output)" }] };
			} catch (error) {
				return { content: [{ type: "text" as const, text: errorText(error) }], isError: true };
			}
		};
		if (tool.executionMode !== "sequential") return run();
		const next = registration.queue.then(run, run);
		registration.queue = next.catch(() => undefined);
		return next;
	}
}

class BodyTooLargeError extends Error {}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new BodyTooLargeError("Request body too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}
