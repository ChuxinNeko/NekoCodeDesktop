import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { discoverNativePlugins, installNativePlugin, parseNativePluginManifest, describeNativePlugin, removeNativePlugin } from "../../src/main/native-plugin-manifest";
import { createNativePluginBridge, nativePluginStates } from "../../src/main/native-plugin-runtime";
import { PluginService } from "../../src/main/plugin-service";
import { projectRunsCode } from "../../src/main/plugin-resources";
import { pi, piAi } from "../../src/main/pi";

const directories: string[] = [];
function temp() { const path = mkdtempSync(join(tmpdir(), "neko-native-plugin-")); directories.push(path); return path; }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const manifest = { id: "test-plugin", name: "Test plugin", version: "1.0.0", apiVersion: 1, main: "index.mjs" };
function plugin(root: string, code: string, overrides = {}) {
	mkdirSync(root, { recursive: true });
	const data = { ...manifest, ...overrides };
	writeFileSync(join(root, "nekocode.plugin.json"), JSON.stringify(data));
	writeFileSync(join(root, data.main), code);
	return root;
}
const code = `export default { activate(api) {
 api.registerTool({ name: "greet", description: "Greet someone", inputSchema: {type:"object",properties:{name:{type:"string",minLength:1}},required:["name"],additionalProperties:false}, execute(input,ctx) { return input.name + ":" + ctx.sessionId; } });
 api.registerCommand({name:"hello",description:"Say hello",execute(args,ctx){ctx.notify("hello "+args)}});
 api.on("session.start", (event,ctx)=>ctx.notify("start:"+event.reason));
 api.on("agent.start", (_event,ctx)=>ctx.notify("agent"));
} };`;

function context(cwd: string) {
	const notifications: string[] = [];
	return { notifications, ctx: { cwd, sessionManager: { getSessionId: () => "session-test" }, hasUI: true, ui: { notify: (message: string) => notifications.push(message) }, signal: undefined } as unknown as ExtensionContext };
}
async function emit(result: LoadExtensionsResult, event: { type: string; [key: string]: unknown }, ctx: ExtensionContext) {
	for (const extension of result.extensions) for (const handler of extension.handlers.get(event.type as never) ?? []) await handler(event, ctx);
}
async function loader(cwd: string, agentDir: string, enabled: Set<string>, askTrust?: () => Promise<"once" | "never">) {
	const { DefaultResourceLoader } = await pi();
	const bridge = createNativePluginBridge({ cwd, agentDir, policy: { isEnabled: source => enabled.has(source), askTrust } });
	const resources = new DefaultResourceLoader({ cwd, agentDir, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [bridge.extension], extensionsOverride: bridge.annotate });
	await resources.reload();
	expect(resources.getExtensions().errors).toEqual([]);
	return resources;
}

describe("NekoCode native manifest and installation", () => {
	test("rejects incompatible versions, invalid IDs and absolute entry paths", () => {
		for (const value of [{ apiVersion: 2 }, { id: "../escape" }, { main: "C:\\outside.js" }, { main: "/outside.js" }, { main: "index.ts" }]) expect(() => parseNativePluginManifest({ ...manifest, ...value })).toThrow();
	});
	test("rejects an entry outside the plugin and reports malformed manifests", async () => {
		const root = temp();
		writeFileSync(join(root, "outside.mjs"), "export default {};");
		const directory = join(root, "plugins", "escape"); mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "nekocode.plugin.json"), JSON.stringify({ ...manifest, main: "../../outside.mjs" }));
		expect((await describeNativePlugin(directory, "user")).error).toContain("inside");
	});
	test("installs a local folder without executing it and removes only the discovered plugin", async () => {
		const cwd = temp(), agentDir = temp();
		const marker = join(cwd, "executed");
		const root = plugin(join(cwd, "source with spaces"), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'yes');export default {activate(){}};`);
		const service = new PluginService({ statePath: join(agentDir, "enabled.json"), agentDir, onChange: () => {} });
		await service.install(cwd, { source: root, scope: "user" });
		const snapshot = await service.list(cwd, undefined);
		expect(snapshot.plugins[0]).toMatchObject({ kind: "nekocode", name: "Test plugin", enabled: false });
		expect(existsSync(marker)).toBe(false);
		await expect(installNativePlugin(cwd, agentDir, root, "user")).rejects.toThrow("already installed");
		await expect(removeNativePlugin(cwd, agentDir, "nekocode:user:../outside")).rejects.toThrow("no longer exists");
		await service.remove(cwd, { source: snapshot.plugins[0].source, scope: "user" });
		expect(await discoverNativePlugins(cwd, agentDir)).toEqual([]);
		expect(existsSync(root)).toBe(true);
		// A stale enabled entry from a manually removed folder never authorizes a reinstall.
		service.setEnabled({ source: snapshot.plugins[0].source, scope: "user", enabled: true });
		await service.install(cwd, { source: root, scope: "user" });
		expect((await service.list(cwd, undefined)).plugins[0].enabled).toBe(false);
	}, 30_000);
});

describe("native plugin runtime", () => {
	test("disabled code is never imported", async () => {
		const cwd = temp(), agentDir = temp(), marker = join(cwd, "imported");
		plugin(join(agentDir, "plugins", "test-plugin"), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'yes');export default {activate(){}};`);
		const resources = await loader(cwd, agentDir, new Set());
		expect(existsSync(marker)).toBe(false);
		expect(nativePluginStates(resources.getExtensions())).toEqual([]);
	});
	test("registers callable tools, slash commands and session events through the real resource loader", async () => {
		const cwd = temp(), agentDir = temp();
		plugin(join(agentDir, "plugins", "test-plugin"), code);
		const descriptor = (await discoverNativePlugins(cwd, agentDir))[0];
		const enabled = new Set([descriptor.source]);
		const resources = await loader(cwd, agentDir, enabled);
		const result = resources.getExtensions();
		const state = nativePluginStates(result)[0];
		expect(state).toMatchObject({ tools: ["neko_test_plugin__greet"], commands: ["test-plugin.hello"] });
		const extension = result.extensions.find(entry => entry.path === "<inline:nekocode-native>")!;
		const tool = extension.tools.get(state.tools[0])!.definition;
		const { ctx, notifications } = context(cwd);
		expect(await tool.execute("call", { name: "Neko" }, undefined, undefined, ctx as never)).toMatchObject({ content: [{ type: "text", text: "Neko:session-test" }] });
		const { validateToolArguments } = await piAi();
		expect(() => validateToolArguments(tool, { type: "toolCall", id: "bad", name: tool.name, arguments: { name: [] } })).toThrow();
		await extension.commands.get("test-plugin.hello")!.handler("World", ctx as never);
		await emit(result, { type: "session_start", reason: "startup" }, ctx);
		await emit(result, { type: "agent_start" }, ctx);
		expect(notifications).toEqual(["hello World", "start:startup", "agent"]);
		const service = new PluginService({ statePath: join(agentDir, "enabled.json"), agentDir, onChange: () => {} });
		service.setEnabled({ source: descriptor.source, scope: "user", enabled: true });
		expect(service.enabledTools(result)).toContain(tool.name);
		expect((await service.list(cwd, result)).plugins[0].commands).toEqual(["test-plugin.hello"]);
		enabled.clear();
		service.setEnabled({ source: descriptor.source, scope: "user", enabled: false });
		expect(service.enabledTools(result)).not.toContain(tool.name);
		await expect(tool.execute("call", { name: "Neko" }, undefined, undefined, ctx as never)).rejects.toThrow("disabled");
		await expect(extension.commands.get("test-plugin.hello")!.handler("World", ctx as never)).rejects.toThrow("disabled");
		await emit(result, { type: "session_shutdown", reason: "reload" }, ctx);
	});
	test("failed activation leaves no staged tools or commands, and another plugin still loads", async () => {
		const cwd = temp(), agentDir = temp();
		plugin(join(agentDir, "plugins", "bad"), code.replace('api.on("agent.start", (_event,ctx)=>ctx.notify("agent"));', 'throw new Error("activation failed");'));
		plugin(join(agentDir, "plugins", "good"), code, { id: "good-plugin" });
		const descriptors = await discoverNativePlugins(cwd, agentDir);
		const resources = await loader(cwd, agentDir, new Set(descriptors.map(d => d.source)));
		const states = nativePluginStates(resources.getExtensions());
		expect(states[0].error).toContain("activation failed");
		expect(states[0].tools).toEqual([]);
		const tools = [...resources.getExtensions().extensions.flatMap(entry => [...entry.tools.keys()])];
		expect(tools).toEqual(["neko_good_plugin__greet"]);
	});
	test("project code is not imported without trust, then can be enabled after trust", async () => {
		const cwd = temp(), agentDir = temp(), marker = join(cwd, "imported");
		plugin(join(cwd, ".nekocode", "plugins", "test-plugin"), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'yes');` + code);
		expect(projectRunsCode(join(cwd, ".nekocode"))).toBe(true);
		const descriptor = (await discoverNativePlugins(cwd, agentDir))[0];
		const enabled = new Set([descriptor.source]);
		const denied = await loader(cwd, agentDir, enabled);
		expect(existsSync(marker)).toBe(false);
		expect(nativePluginStates(denied.getExtensions())[0].error).toContain("not trusted");
		const allowed = await loader(cwd, agentDir, enabled, async () => "once");
		expect(existsSync(marker)).toBe(true);
		expect(nativePluginStates(allowed.getExtensions())[0].tools).toEqual(["neko_test_plugin__greet"]);
		await emit(allowed.getExtensions(), { type: "session_shutdown", reason: "quit" }, context(cwd).ctx);
	});
	test("reload imports fresh bundled code and runs deactivate once per activation", async () => {
		const cwd = temp(), agentDir = temp(), log = join(cwd, "lifecycle.txt");
		const root = join(agentDir, "plugins", "test-plugin");
		const version = (text: string) => `import{appendFileSync}from'node:fs';export default { activate(api){ appendFileSync(${JSON.stringify(log)},${JSON.stringify(text + "\n")}); api.on('session.start',()=>{}); },deactivate(){appendFileSync(${JSON.stringify(log)},'dispose\\n')} };`;
		plugin(root, version("v1"));
		const enabled = new Set([(await discoverNativePlugins(cwd, agentDir))[0].source]);
		const resources = await loader(cwd, agentDir, enabled);
		const ctx = context(cwd).ctx;
		await emit(resources.getExtensions(), { type: "session_shutdown", reason: "reload" }, ctx);
		await emit(resources.getExtensions(), { type: "session_shutdown", reason: "reload" }, ctx);
		writeFileSync(join(root, "index.mjs"), version("v2"));
		await resources.reload();
		await emit(resources.getExtensions(), { type: "session_shutdown", reason: "quit" }, ctx);
		expect(readFileSync(log, "utf8").replaceAll("\\n", "\n")).toBe("v1\ndispose\nv2\ndispose\n");
	});
	test("the shipped example is a self-contained native plugin", async () => {
		const cwd = temp(), agentDir = temp();
		await installNativePlugin(cwd, agentDir, resolve("resources/plugin-examples/hello-world"), "user");
		const descriptor = (await discoverNativePlugins(cwd, agentDir))[0];
		const resources = await loader(cwd, agentDir, new Set([descriptor.source]));
		expect(nativePluginStates(resources.getExtensions())[0]).toMatchObject({ tools: ["neko_hello_world__greet"], commands: ["hello-world.hello"] });
		await emit(resources.getExtensions(), { type: "session_shutdown", reason: "quit" }, context(cwd).ctx);
	});
});
