export type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

let piModulePromise: Promise<PiCodingAgentModule> | null = null;

/**
 * Load the PI SDK on first use.
 *
 * `@earendil-works/pi-coding-agent` is ESM-only while the Electron main bundle is
 * CJS, so a static import compiles to `require()` and fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED. The dynamic `import()` is also why the SDK is not
 * pulled in during startup: it brings a native clipboard module that would bloat
 * the main process before any session exists.
 */
export function pi(): Promise<PiCodingAgentModule> {
	piModulePromise ??= import("@earendil-works/pi-coding-agent");
	return piModulePromise;
}
