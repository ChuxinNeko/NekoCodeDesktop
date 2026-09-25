/**
 * JSON-RPC 2.0 for the Agent Client Protocol.
 *
 * Unlike MCP, ACP is bidirectional: besides answering our requests the agent
 * sends requests of its own (permission prompts, file reads) and expects
 * answers. Framing is left to the transport, so tests drive this with an
 * in-memory one.
 */

export interface AcpTransport {
	send(message: object): Promise<void>;
	onMessage(listener: (message: unknown) => void): void;
	onClose(listener: (reason: string) => void): void;
	close(): void;
}

export class AcpRpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "AcpRpcError";
	}
}

export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;
/** ACP's code for "call `authenticate` first". */
export const AUTH_REQUIRED = -32000;

type RequestId = number | string;
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * An RPC error as a person should read it. Agents tend to send a generic
 * message ("Internal error") and put the actual cause in `data`.
 */
function errorMessage(error: Record<string, unknown>): string {
	const message = typeof error.message === "string" ? error.message : "Unknown error";
	const data = error.data;
	const detail =
		typeof data === "string"
			? data
			: isObject(data)
				? [data.details, data.detail, data.message, data.error].find((value) => typeof value === "string")
				: undefined;
	return typeof detail === "string" && detail && detail !== message ? `${message}: ${detail}` : message;
}

export class AcpConnection {
	private nextId = 1;
	private readonly pending = new Map<RequestId, Pending>();
	private requestHandler: RequestHandler | null = null;
	private notificationHandler: NotificationHandler | null = null;
	private closeListeners: Array<(reason: string) => void> = [];
	private closedReason: string | null = null;

	constructor(private readonly transport: AcpTransport) {
		transport.onMessage((message) => this.receive(message));
		transport.onClose((reason) => this.shutdown(reason));
	}

	get closed(): boolean {
		return this.closedReason !== null;
	}

	onRequest(handler: RequestHandler): void {
		this.requestHandler = handler;
	}

	onNotification(handler: NotificationHandler): void {
		this.notificationHandler = handler;
	}

	onClose(listener: (reason: string) => void): void {
		if (this.closedReason !== null) listener(this.closedReason);
		else this.closeListeners.push(listener);
	}

	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		if (this.closedReason !== null) return Promise.reject(new Error(this.closedReason));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.transport.send({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	notify(method: string, params?: unknown): Promise<void> {
		if (this.closedReason !== null) return Promise.resolve();
		return this.transport.send({ jsonrpc: "2.0", method, params });
	}

	close(reason = "连接已关闭"): void {
		this.transport.close();
		this.shutdown(reason);
	}

	private receive(message: unknown): void {
		if (!isObject(message)) return;
		const id = message.id;
		const hasId = typeof id === "number" || typeof id === "string";
		const method = typeof message.method === "string" ? message.method : null;

		if (method && hasId) {
			void this.answer(id, method, message.params);
			return;
		}
		if (method) {
			try {
				this.notificationHandler?.(method, message.params);
			} catch {
				// One bad update must not take the connection down with it.
			}
			return;
		}
		if (!hasId) return;
		const waiter = this.pending.get(id);
		if (!waiter) return;
		this.pending.delete(id);
		if (isObject(message.error)) {
			const error = message.error;
			waiter.reject(
				new AcpRpcError(
					typeof error.code === "number" ? error.code : INTERNAL_ERROR,
					errorMessage(error),
					error.data,
				),
			);
		} else {
			waiter.resolve(message.result);
		}
	}

	private async answer(id: RequestId, method: string, params: unknown): Promise<void> {
		let reply: object;
		try {
			if (!this.requestHandler) throw new AcpRpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
			const result = await this.requestHandler(method, params);
			reply = { jsonrpc: "2.0", id, result: result ?? null };
		} catch (error) {
			const code = error instanceof AcpRpcError ? error.code : INTERNAL_ERROR;
			const text = error instanceof Error ? error.message : String(error);
			reply = { jsonrpc: "2.0", id, error: { code, message: text } };
		}
		if (this.closedReason !== null) return;
		await this.transport.send(reply).catch(() => undefined);
	}

	private shutdown(reason: string): void {
		if (this.closedReason !== null) return;
		this.closedReason = reason;
		for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
		this.pending.clear();
		const listeners = this.closeListeners;
		this.closeListeners = [];
		for (const listener of listeners) listener(reason);
	}
}
