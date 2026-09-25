import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonRpcNotification, JsonRpcRequest } from "./protocol";

/** Stderr kept per server for the settings panel; a server can be chatty. */
const STDERR_KEEP = 4000;

export interface McpTransport {
	send(message: JsonRpcRequest | JsonRpcNotification): Promise<void>;
	/** Called for every decoded message the server sends. */
	onMessage(listener: (message: unknown) => void): void;
	/** Called once when the transport dies on its own. */
	onClose(listener: (reason: string) => void): void;
	close(): void;
}

/**
 * A server this app runs, spoken to over its stdin/stdout.
 *
 * Framing is newline-delimited JSON. Stderr is drained rather than ignored:
 * a misconfigured server usually explains itself there and then exits, and
 * without it the only symptom would be a connection that closed.
 */
export class StdioTransport implements McpTransport {
	private child: ChildProcessWithoutNullStreams | null;
	private buffer = "";
	private stderr = "";
	private messageListener: ((message: unknown) => void) | null = null;
	private closeListener: ((reason: string) => void) | null = null;
	private closed = false;

	constructor(options: {
		command: string;
		args: string[];
		env: Record<string, string>;
		cwd: string;
		/** Defaults to a shell on Windows; an absolute executable needs none. */
		shell?: boolean;
	}) {
		this.child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
			// Servers are commonly `npx …`, which on Windows is a shell script.
			shell: options.shell ?? process.platform === "win32",
			// A GUI app spawning a console program gets a console window otherwise.
			windowsHide: true,
		});

		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_KEEP);
		});
		this.child.on("error", (error) => this.die(error.message));
		this.child.on("close", (code) =>
			this.die(this.stderr.trim() || `服务器进程退出（code ${String(code)}）`),
		);
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) {
				try {
					this.messageListener?.(JSON.parse(line));
				} catch {
					// A line that is not JSON is a server writing logs to stdout.
					// Skipping it keeps the session usable; killing it would not.
				}
			}
			newline = this.buffer.indexOf("\n");
		}
	}

	private die(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.child = null;
		this.closeListener?.(reason);
	}

	async send(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
		const child = this.child;
		if (!child) throw new Error("MCP 服务器已断开");
		await new Promise<void>((resolve, reject) => {
			child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
				error ? reject(error) : resolve(),
			);
		});
	}

	onMessage(listener: (message: unknown) => void): void {
		this.messageListener = listener;
	}

	onClose(listener: (reason: string) => void): void {
		this.closeListener = listener;
	}

	close(): void {
		const child = this.child;
		this.closed = true;
		this.child = null;
		if (child) killProcessTree(child);
	}
}

/**
 * On Windows the child is `cmd.exe` running the real program (see `shell`
 * above), and killing it leaves `npx` and the node process it started running
 * as orphans. `taskkill /T` takes the whole tree down.
 */
function killProcessTree(child: ChildProcessWithoutNullStreams): void {
	if (process.platform === "win32" && child.pid !== undefined) {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.on("error", () => child.kill());
		return;
	}
	child.kill();
}

/**
 * A hosted server, spoken to with one POST per request.
 *
 * No SSE stream is opened: without it the server cannot push notifications,
 * which costs live `tools/list_changed` updates and nothing else that matters
 * for calling tools. The tool list is re-read on reconnect instead.
 */
export class HttpTransport implements McpTransport {
	private messageListener: ((message: unknown) => void) | null = null;
	private closeListener: ((reason: string) => void) | null = null;
	private sessionId: string | null = null;
	private closed = false;

	constructor(private readonly options: { url: string; headers: Record<string, string> }) {}

	async send(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
		if (this.closed) throw new Error("MCP 服务器已断开");
		let response: Response;
		try {
			response = await fetch(this.options.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
					...this.options.headers,
				},
				body: JSON.stringify(message),
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.fail(reason);
			throw new Error(reason);
		}
		// The server assigns a session on initialize and expects it echoed back.
		const assigned = response.headers.get("mcp-session-id");
		if (assigned) this.sessionId = assigned;

		if (!response.ok) {
			const reason = `HTTP ${String(response.status)} ${response.statusText}`.trim();
			this.fail(reason);
			throw new Error(reason);
		}
		// A notification is answered with 202 and no body.
		if (response.status === 204 || !("id" in message)) return;

		const body = await response.text();
		if (!body.trim()) return;
		for (const decoded of decodeBody(response.headers.get("content-type") ?? "", body)) {
			this.messageListener?.(decoded);
		}
	}

	private fail(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.closeListener?.(reason);
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
}

/**
 * Pull JSON-RPC messages out of a response body.
 *
 * A streamable-HTTP server may answer a single post with either plain JSON or
 * an SSE stream carrying one message per `data:` line, and which one it picks
 * is the server's choice rather than the client's.
 */
function decodeBody(contentType: string, body: string): unknown[] {
	if (!contentType.includes("text/event-stream")) {
		try {
			return [JSON.parse(body)];
		} catch {
			return [];
		}
	}
	const messages: unknown[] = [];
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			messages.push(JSON.parse(payload));
		} catch {
			// Partial frame; the next post re-reads what matters.
		}
	}
	return messages;
}
