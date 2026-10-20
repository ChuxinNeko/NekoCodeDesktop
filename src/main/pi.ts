import { installWindowsFsyncCompat } from "./windows-fsync";

export type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

let piModulePromise: Promise<PiCodingAgentModule> | null = null;

export type PiModelsModule = typeof import("@earendil-works/pi-coding-agent/model-runtime")
	& typeof import("@earendil-works/pi-coding-agent/settings");
let piModelsPromise: Promise<PiModelsModule> | null = null;

/**
 * Welcome-screen model defaults must not load the SDK's CLI, terminal UI,
 * clipboard and extension tooling. These public entries resolve to the same
 * modules the full SDK uses, so sessions retain one model runtime and identity.
 */
export function piModels(): Promise<PiModelsModule> {
	piModelsPromise ??= installWindowsFsyncCompat().then(async () => {
		const [models, settings] = await Promise.all([
			import("@earendil-works/pi-coding-agent/model-runtime"),
			import("@earendil-works/pi-coding-agent/settings"),
		]);
		return { ...models, ...settings };
	});
	return piModelsPromise;
}

/**
 * Load the PI SDK on first use.
 *
 * `@earendil-works/pi-coding-agent` is ESM-only while the Electron main bundle is
 * CJS, so a static import compiles to `require()` and fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED. Keep the full SDK lazy for session/tool
 * operations. Model defaults use piModels() so
 * startup does not pay for its CLI, terminal UI and native clipboard module.
 */
export function pi(): Promise<PiCodingAgentModule> {
	// Before the SDK, so before any plugin it loads has written a file.
	piModulePromise ??= installWindowsFsyncCompat().then(() => import("@earendil-works/pi-coding-agent"));
	return piModulePromise;
}

export type PiAiModule = typeof import("@earendil-works/pi-ai");

let piAiModulePromise: Promise<PiAiModule> | null = null;

/**
 * Load pi-ai on first use. ESM-only like pi-coding-agent — a static import would
 * compile to `require()` in the CJS main bundle and fail.
 */
export function piAi(): Promise<PiAiModule> {
	piAiModulePromise ??= import("@earendil-works/pi-ai");
	return piAiModulePromise;
}

export type PiMcpModule = typeof import("@earendil-works/pi-mcp");
export type PiMcpOAuthModule = typeof import("@earendil-works/pi-mcp/oauth");

let piMcpModulePromise: Promise<PiMcpModule> | null = null;
let piMcpOAuthModulePromise: Promise<PiMcpOAuthModule> | null = null;

/** Load the MCP client on first use; ESM-only like the rest of pi. */
export function piMcp(): Promise<PiMcpModule> {
	piMcpModulePromise ??= import("@earendil-works/pi-mcp");
	return piMcpModulePromise;
}

/** MCP's OAuth half, a separate entry point: only servers that sign in need it. */
export function piMcpOAuth(): Promise<PiMcpOAuthModule> {
	piMcpOAuthModulePromise ??= import("@earendil-works/pi-mcp/oauth");
	return piMcpOAuthModulePromise;
}
