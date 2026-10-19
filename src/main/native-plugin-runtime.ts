import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { NekoPlugin, PluginAPI, PluginCommand, PluginContext, PluginEvents, PluginTool, ToolResult } from "../../packages/plugin-api";
import { discoverNativePlugins, type NativePluginDescriptor } from "./native-plugin-manifest";
import { resolvePluginTrust, type PluginResourcePolicy } from "./plugin-resources";

const INLINE_NAME = "nekocode-native";
export interface NativePluginState { source: string; tools: string[]; commands: string[]; error?: string }
type Extension = LoadExtensionsResult["extensions"][number] & { nekocodePlugins?: NativePluginState[] };

export function nativePluginStates(result: LoadExtensionsResult | undefined): NativePluginState[] {
	return result?.extensions.flatMap(extension => (extension as Extension).nekocodePlugins ?? []) ?? [];
}

async function deadline<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); })]);
	} finally { clearTimeout(timer); }
}

function localName(value: string): void {
	if (!/^[a-z][a-z0-9_]{0,23}$/.test(value)) throw new Error("Tool/command names must be 1–24 lowercase letters, digits or underscores, starting with a letter");
}

/** One host extension, while the public SDK and all plugin ownership remain NekoCode's. */
export function createNativePluginBridge(options: { cwd: string; agentDir: string; policy: PluginResourcePolicy }): {
	extension: InlineExtension;
	annotate(result: LoadExtensionsResult): LoadExtensionsResult;
} {
	let states: NativePluginState[] = [];
	return {
		extension: { name: INLINE_NAME, hidden: true, factory: async core => {
			states = [];
			const descriptors = await discoverNativePlugins(options.cwd, options.agentDir);
			const projectAllowed = descriptors.some(plugin => plugin.scope === "project" && options.policy.isEnabled(plugin.source))
				? await resolvePluginTrust(options.cwd, options.agentDir, options.policy.askTrust) : false;
			const ids = new Set<string>();
			for (const descriptor of descriptors) {
				if (!options.policy.isEnabled(descriptor.source)) continue;
				const state: NativePluginState = { source: descriptor.source, tools: [], commands: [] };
				states.push(state);
				if (descriptor.error || !descriptor.manifest || !descriptor.entry) { state.error = descriptor.error ?? "Invalid plugin"; continue; }
				if (descriptor.scope === "project" && !projectAllowed) { state.error = "Project is not trusted; native plugin code was not loaded"; continue; }
				if (ids.has(descriptor.manifest.id)) { state.error = `Duplicate enabled native plugin id: ${descriptor.manifest.id}`; continue; }
				ids.add(descriptor.manifest.id);
				await activateNativePlugin(core, descriptor, state, () => options.policy.isEnabled(descriptor.source));
			}
		} },
		annotate(result) {
			const extension = result.extensions.find(entry => entry.path === `<inline:${INLINE_NAME}>`) as Extension | undefined;
			if (extension) extension.nekocodePlugins = states;
			return result;
		},
	};
}

async function activateNativePlugin(core: ExtensionAPI, descriptor: NativePluginDescriptor, state: NativePluginState, enabled: () => boolean): Promise<void> {
	const manifest = descriptor.manifest!;
	const lifetime = new AbortController();
	let plugin: NekoPlugin | undefined;
	let registrationOpen = true;
	let disposed = false;
	const tools = new Map<string, PluginTool>();
	const commands = new Map<string, PluginCommand>();
	const handlers = new Map<keyof PluginEvents, Set<(event: never, context: PluginContext) => void | Promise<void>>>();
	const assertActive = () => { if (disposed || !enabled()) throw new Error(`Native plugin ${manifest.id} is disabled or unloaded`); };
	const context = (ctx: ExtensionContext, signal?: AbortSignal): PluginContext => {
		const operationSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
		return {
			cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), signal: operationSignal,
			notify(message, level = "info") {
				assertActive();
				if (operationSignal.aborted) throw new Error(`Native plugin ${manifest.id} operation was cancelled`);
				if (ctx.hasUI) ctx.ui.notify(message, level);
			},
		};
	};
	const dispose = async () => {
		if (disposed) return;
		disposed = true;
		lifetime.abort();
		handlers.clear();
		if (plugin?.deactivate) await deadline(Promise.resolve().then(() => plugin!.deactivate!()), 1000, `Plugin ${manifest.id} deactivate`);
	};
	const api: PluginAPI = {
		apiVersion: 1, plugin: Object.freeze({ ...manifest }), signal: lifetime.signal,
		registerTool(tool) {
			assertActive();
			if (!registrationOpen) throw new Error("Register tools during activate()");
			localName(tool.name);
			if (!tool.description?.trim() || tool.inputSchema?.type !== "object" || typeof tool.execute !== "function") throw new Error("A tool needs a description, object inputSchema and execute function");
			const name = `neko_${manifest.id.replaceAll("-", "_")}__${tool.name}`;
			if (tools.has(name)) throw new Error(`Duplicate tool: ${name}`);
			tools.set(name, tool as PluginTool);
			return name;
		},
		registerCommand(command) {
			assertActive();
			if (!registrationOpen) throw new Error("Register commands during activate()");
			localName(command.name);
			if (!command.description?.trim() || typeof command.execute !== "function") throw new Error("A command needs a description and execute function");
			const name = `${manifest.id}.${command.name}`;
			if (commands.has(name)) throw new Error(`Duplicate command: ${name}`);
			commands.set(name, command);
			return name;
		},
		on(event, handler) {
			assertActive();
			if (!["session.start", "session.stop", "agent.start", "agent.stop", "tool.start", "tool.end"].includes(event) || typeof handler !== "function") throw new Error(`Unknown plugin lifecycle event: ${event}`);
			let set = handlers.get(event);
			if (!set) { set = new Set(); handlers.set(event, set); }
			const callback = handler as (event: never, context: PluginContext) => void | Promise<void>;
			set.add(callback);
			return { dispose: () => { set.delete(callback); } };
		},
	};
	try {
		await deadline((async () => {
			const require = createRequire(join(descriptor.root, "package.json"));
			delete require.cache[descriptor.entry!];
			const url = pathToFileURL(descriptor.entry!);
			url.searchParams.set("nekocodeReload", randomUUID());
			const module = await import(/* @vite-ignore */ url.href);
			if (disposed) return;
			plugin = module.default;
			if (!plugin || typeof plugin.activate !== "function") throw new Error("Native plugin must default-export an object with activate(api)");
			await plugin.activate(api);
		})(), 10_000, `Plugin ${manifest.id} activation`);
		registrationOpen = false;
		assertActive();
		// Commit only after successful activation: a failed plugin contributes no tools or hooks.
		for (const [name, tool] of tools) {
			core.registerTool({ name, label: name, description: tool.description, parameters: Type.Unsafe(tool.inputSchema),
				executionMode: "sequential", async execute(_id, input, signal, _update, ctx) {
					assertActive();
					const result = await tool.execute(input as Record<string, unknown>, context(ctx, signal ?? ctx.signal));
					if (typeof result === "string") return { content: [{ type: "text", text: result }], details: undefined };
					const value = result as ToolResult;
					if (!value || !Array.isArray(value.content) || value.content.some(item => item.type !== "text" || typeof item.text !== "string")) throw new Error(`Invalid result from native plugin tool ${name}`);
					return { content: value.content, details: value.details };
				},
			});
		}
		for (const [name, command] of commands) core.registerCommand(name, { description: command.description, handler: async (args, ctx) => { assertActive(); await command.execute(args, context(ctx, ctx.signal)); } });
		state.tools = [...tools.keys()];
		state.commands = [...commands.keys()];
		const dispatch = async <K extends keyof PluginEvents>(event: K, data: PluginEvents[K], ctx: ExtensionContext) => {
			if (disposed || !enabled()) return;
			const operation = new AbortController();
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, operation.signal]) : operation.signal;
			try {
				await deadline((async () => {
					for (const handler of [...(handlers.get(event) ?? [])]) {
						if (operation.signal.aborted || disposed || !enabled()) break;
						await handler(data as never, context(ctx, signal));
					}
				})(), event === "session.stop" ? 1000 : 10_000, `Plugin ${manifest.id} ${event}`);
			} catch (error) {
				state.error = `${manifest.id}: ${error instanceof Error ? error.message : String(error)}`;
				throw new Error(state.error);
			} finally { operation.abort(); }
		};
		core.on("session_start", (event, ctx) => dispatch("session.start", { reason: event.reason }, ctx));
		core.on("agent_start", (_event, ctx) => dispatch("agent.start", {}, ctx));
		core.on("agent_end", (_event, ctx) => dispatch("agent.stop", {}, ctx));
		core.on("tool_execution_start", (event, ctx) => dispatch("tool.start", { toolName: event.toolName, toolCallId: event.toolCallId, input: event.args }, ctx));
		core.on("tool_execution_end", (event, ctx) => dispatch("tool.end", { toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError }, ctx));
		core.on("session_shutdown", async (event, ctx) => { try { await dispatch("session.stop", { reason: event.reason }, ctx); } finally { await dispose(); } });
	} catch (error) {
		registrationOpen = false;
		state.error = error instanceof Error ? error.message : String(error);
		try { await dispose(); } catch (cleanup) { state.error += `; cleanup: ${String(cleanup)}`; }
	}
}
