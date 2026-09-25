import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { CuaDriverLike } from "@trycua/cua-driver";
import { RAISE_WINDOW, type ComputerCallResult, type WorkerRequest, type WorkerResponse } from "./protocol";
import { raiseWindow } from "./window-raise";

/**
 * Utility-process entry that owns the Cua driver.
 *
 * One driver per process, created on start and used for every call. The main
 * process talks to it over `parentPort` with the messages in `./protocol`.
 */

// Set before the library loads: the driver reads it once at start-up, and its
// default is to report usage. Nothing about the user's desktop is ours to send.
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "0";

const esmImport = new Function("specifier", "return import(specifier)") as (
	specifier: string,
) => Promise<typeof import("@trycua/cua-driver")>;

/**
 * Where the SDK's entry file is, outside any asar archive.
 *
 * The package is ESM-only with no `require` export, so `require.resolve` cannot
 * find it; the directory walk does what module resolution would. And the native
 * runtime loads its DLL by path, which Windows cannot open inside app.asar —
 * so a packaged build imports the unpacked copy, and every relative lookup the
 * SDK makes from there stays unpacked too.
 */
export function locateDriverEntry(from: string): string {
	const unpacked = (path: string) =>
		path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
	let dir = from;
	for (;;) {
		const candidate = join(dir, "node_modules", "@trycua", "cua-driver", "dist", "index.js");
		if (existsSync(candidate)) return unpacked(candidate);
		const parent = dirname(dir);
		if (parent === dir) throw new Error("找不到 @trycua/cua-driver 模块");
		dir = parent;
	}
}

function send(message: WorkerResponse): void {
	process.parentPort.postMessage(message);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	// UniFFI errors are plain objects carrying the Rust variant's message.
	if (error && typeof error === "object" && "message" in error) return String(error.message);
	return String(error);
}

async function main(): Promise<void> {
	let driver: CuaDriverLike;
	try {
		const sdk = await esmImport(pathToFileURL(locateDriverEntry(__dirname)).href);
		driver = sdk.CuaDriver.create(undefined);
		if (!driver.isAvailable()) throw new Error("Computer Use 驱动在当前系统上不可用");
	} catch (error) {
		send({ type: "fatal", message: errorMessage(error) });
		return;
	}

	const running = new Map<number, AbortController>();
	process.parentPort.on("message", (event) => {
		const request = event.data as WorkerRequest;
		if (request.type === "cancel") {
			running.get(request.id)?.abort();
			return;
		}
		if (request.name === RAISE_WINDOW) {
			try {
				send({ type: "result", id: request.id, result: raiseWindow(request.args) });
			} catch (error) {
				send({ type: "error", id: request.id, message: errorMessage(error) });
			}
			return;
		}
		const controller = new AbortController();
		running.set(request.id, controller);
		driver
			.callTool(request.name, JSON.stringify(request.args), { signal: controller.signal })
			.then((raw) => {
				const result: ComputerCallResult = {
					text: raw.text ?? "",
					images: (raw.images ?? []).map((image) => ({
						data: image.dataBase64,
						mimeType: image.mimeType,
					})),
					isError: raw.isError,
					...(raw.errorCode ? { errorCode: raw.errorCode } : {}),
					...(raw.structuredJson ? { structuredJson: raw.structuredJson } : {}),
				};
				send({ type: "result", id: request.id, result });
			})
			.catch((error: unknown) => send({ type: "error", id: request.id, message: errorMessage(error) }))
			.finally(() => running.delete(request.id));
	});
	send({ type: "ready" });
}

void main();
