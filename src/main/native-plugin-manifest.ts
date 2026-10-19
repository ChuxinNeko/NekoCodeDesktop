import { cp, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { PluginManifest } from "../../packages/plugin-api";
import type { PluginScope } from "../shared/plugins";

export const NATIVE_PLUGIN_MANIFEST = "nekocode.plugin.json";
export const NATIVE_PLUGIN_PREFIX = "nekocode:";

export interface NativePluginDescriptor {
	source: string;
	scope: PluginScope;
	root: string;
	manifest?: PluginManifest;
	entry?: string;
	error?: string;
}

export function nativePluginsDirectory(cwd: string, agentDir: string, scope: PluginScope): string {
	return scope === "user" ? join(agentDir, "plugins") : join(cwd, ".nekocode", "plugins");
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !isAbsolute(rel);
}

export function parseNativePluginManifest(value: unknown): PluginManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin manifest must be an object");
	const manifest = value as Record<string, unknown>;
	if (typeof manifest.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(manifest.id)) throw new Error("Plugin id must be 1–32 lowercase letters, digits or hyphens, starting with a letter");
	if (typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 120) throw new Error("Plugin name must contain 1–120 characters");
	if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(manifest.version)) throw new Error("Plugin version must use semantic versioning");
	if (manifest.apiVersion !== 1) throw new Error(`Unsupported NekoCode plugin API version: ${String(manifest.apiVersion)} (supported: 1)`);
	if (typeof manifest.main !== "string" || isAbsolute(manifest.main) || /^[a-z]:|^[/\\]/i.test(manifest.main) || !/\.(mjs|cjs|js)$/.test(manifest.main)) throw new Error("Plugin main must be a relative .js, .mjs or .cjs path");
	if (manifest.description !== undefined && (typeof manifest.description !== "string" || manifest.description.length > 2000)) throw new Error("Plugin description must be at most 2000 characters");
	return { id: manifest.id, name: manifest.name.trim(), version: manifest.version, apiVersion: 1, main: manifest.main,
		...(typeof manifest.description === "string" ? { description: manifest.description } : {}) };
}

export async function describeNativePlugin(root: string, scope: PluginScope): Promise<NativePluginDescriptor> {
	const descriptor: NativePluginDescriptor = { root: resolve(root), scope, source: `${NATIVE_PLUGIN_PREFIX}${scope}:${resolve(root)}` };
	try {
		const manifest = parseNativePluginManifest(JSON.parse((await readFile(join(root, NATIVE_PLUGIN_MANIFEST), "utf8")).replace(/^\uFEFF/, "")));
		descriptor.manifest = manifest;
		const canonical = await realpath(root);
		const entry = await realpath(resolve(root, manifest.main));
		if (!within(canonical, entry) || !(await stat(entry)).isFile()) throw new Error("Plugin entry must be a file inside its plugin directory");
		descriptor.entry = entry;
	} catch (error) {
		descriptor.error = error instanceof Error ? error.message : String(error);
	}
	return descriptor;
}

/** Discovery reads metadata only; disabled/untrusted modules are never imported. */
export async function discoverNativePlugins(cwd: string, agentDir: string): Promise<NativePluginDescriptor[]> {
	const plugins: NativePluginDescriptor[] = [];
	for (const scope of ["user", "project"] as const) {
		const directory = nativePluginsDirectory(cwd, agentDir, scope);
		let entries;
		try { entries = await readdir(directory, { withFileTypes: true }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			plugins.push(await describeNativePlugin(join(directory, entry.name), scope));
		}
	}
	return plugins;
}

export async function installNativePlugin(cwd: string, agentDir: string, source: string, scope: PluginScope): Promise<NativePluginDescriptor | null> {
	if (scope !== "user" && scope !== "project") throw new Error("Invalid plugin installation scope");
	if (/^(?:npm:|git:|https?:)/i.test(source)) return null;
	const root = resolve(cwd, source);
	if (!existsSync(join(root, NATIVE_PLUGIN_MANIFEST))) return null;
	const descriptor = await describeNativePlugin(root, scope);
	if (descriptor.error || !descriptor.manifest) throw new Error(descriptor.error ?? "Invalid native plugin");
	const directory = nativePluginsDirectory(cwd, agentDir, scope);
	const destination = join(directory, descriptor.manifest.id);
	if (within(await realpath(root), resolve(destination))) throw new Error("Plugin installation directory must not be inside its source directory");
	await mkdir(directory, { recursive: true });
	if (existsSync(destination)) throw new Error("This native plugin is already installed; edit its directory and reload it");
	await mkdir(destination); // Reserve this installation, so concurrent attempts cannot merge files.
	try {
		for (const entry of await readdir(root)) {
			if (entry === ".git") continue;
			await cp(join(root, entry), join(destination, entry), { recursive: true, errorOnExist: true, force: false, filter: path => basename(path) !== ".git" });
		}
	} catch (error) {
		// destination is the reserved direct child of this installation directory.
		if (within(resolve(directory), resolve(destination))) await rm(destination, { recursive: true, force: true });
		throw error;
	}
	return describeNativePlugin(destination, scope);
}

export async function removeNativePlugin(cwd: string, agentDir: string, source: string): Promise<void> {
	const descriptor = (await discoverNativePlugins(cwd, agentDir)).find(plugin => plugin.source === source);
	if (!descriptor) throw new Error("Native plugin no longer exists");
	const parent = await realpath(nativePluginsDirectory(cwd, agentDir, descriptor.scope));
	const target = await realpath(descriptor.root);
	if (!within(parent, target) || relative(parent, target).includes("\\") || relative(parent, target).includes("/")) throw new Error("Invalid native plugin removal path");
	await rm(target, { recursive: true, force: false });
}
