/**
 * The slice of MCP this app speaks.
 *
 * Hand-written rather than taken from the official SDK: that package is ESM
 * with subpath exports, which the CJS main bundle can only reach through the
 * dynamic-import dance in `pi.ts`, and the surface actually needed here is the
 * handshake plus two tool calls. Anything unrecognised on the wire is ignored,
 * so a server speaking a later revision still works for tools.
 */

/** What we claim to speak. Servers echo their own; a mismatch is not fatal. */
export const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export function isResponse(message: unknown): message is JsonRpcResponse {
	return (
		!!message &&
		typeof message === "object" &&
		"id" in message &&
		typeof (message as { id: unknown }).id === "number"
	);
}

/** One tool as the server describes it. `inputSchema` is JSON Schema. */
export interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpListToolsResult {
	tools?: McpToolDescriptor[];
}

/**
 * A tool result. Only text is rendered — the transcript has no place to put an
 * image a tool returned, and dropping it beats failing the call over it.
 */
export interface McpCallToolResult {
	content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
	isError?: boolean;
}

/** Flatten a tool result into the text the transcript shows. */
export function resultText(result: McpCallToolResult): string {
	const parts = (result.content ?? [])
		.map((entry) => {
			if (typeof entry.text === "string") return entry.text;
			// Non-text content is named rather than dumped: a base64 image inlined
			// into the transcript is megabytes of noise the model cannot use here.
			return `[${entry.type}]`;
		})
		.filter(Boolean);
	return parts.join("\n").trim();
}

/**
 * Coerce a server's declared schema into something the agent core can validate.
 *
 * TypeBox schemas are plain JSON Schema at runtime, so a well-formed
 * `inputSchema` passes straight through. A server that omits it, or sends
 * something that is not an object schema, gets an empty object schema — the
 * tool stays callable with no arguments rather than disappearing.
 */
export function toParameterSchema(inputSchema: unknown): Record<string, unknown> {
	if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
		return { type: "object", properties: {} };
	}
	const schema = { ...(inputSchema as Record<string, unknown>) };
	if (schema.type !== "object") return { type: "object", properties: {} };
	if (typeof schema.properties !== "object" || !schema.properties) schema.properties = {};
	return schema;
}
