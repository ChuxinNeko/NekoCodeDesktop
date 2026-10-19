export declare const API_VERSION = 1;

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	apiVersion: 1;
	/** Relative path to a bundled .js, .mjs or .cjs entry. */
	main: string;
	description?: string;
}

export interface Disposable { dispose(): void | Promise<void> }
export type NotificationLevel = "info" | "warning" | "error";

export interface PluginContext {
	readonly cwd: string;
	readonly sessionId: string;
	/** Aborted when this operation is cancelled or the plugin is unloaded. */
	readonly signal: AbortSignal;
	notify(message: string, level?: NotificationLevel): void;
}

/** JSON Schema, with an object at the root. Inputs are validated by the host. */
export interface InputSchema {
	type: "object";
	properties?: Record<string, Record<string, unknown>>;
	required?: string[];
	additionalProperties?: boolean;
	[key: string]: unknown;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
}

export interface PluginTool<T extends Record<string, unknown> = Record<string, unknown>> {
	/** Local name; exposed to the model as neko_<plugin_id>__<name>. */
	name: string;
	description: string;
	inputSchema: InputSchema;
	execute(input: T, context: PluginContext): string | ToolResult | Promise<string | ToolResult>;
}

export interface PluginCommand {
	/** Local name; users invoke /<plugin-id>.<name> [arguments]. */
	name: string;
	description: string;
	execute(args: string, context: PluginContext): void | Promise<void>;
}

export interface PluginEvents {
	"session.start": { reason: "startup" | "reload" | "new" | "resume" | "fork" };
	"session.stop": { reason: "quit" | "reload" | "new" | "resume" | "fork" };
	"agent.start": Record<string, never>;
	"agent.stop": Record<string, never>;
	"tool.start": { toolName: string; toolCallId: string; input: unknown };
	"tool.end": { toolName: string; toolCallId: string; result: unknown; isError: boolean };
}

export interface PluginAPI {
	readonly apiVersion: 1;
	readonly plugin: Readonly<PluginManifest>;
	/** Lifetime of this activation, including activation failure and session reload. */
	readonly signal: AbortSignal;
	/** Register during activate(). Returns the fully qualified public name. */
	registerTool<T extends Record<string, unknown>>(tool: PluginTool<T>): string;
	registerCommand(command: PluginCommand): string;
	on<K extends keyof PluginEvents>(
		event: K,
		handler: (event: PluginEvents[K], context: PluginContext) => void | Promise<void>,
	): Disposable;
}

export interface NekoPlugin {
	activate(api: PluginAPI): void | Promise<void>;
	/** Called once when activation fails, a session ends, or the plugin is reloaded/disabled. */
	deactivate?(): void | Promise<void>;
}

export declare function definePlugin<T extends NekoPlugin>(plugin: T): T;
