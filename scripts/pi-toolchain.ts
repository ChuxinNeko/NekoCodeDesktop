import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the PI agent core in `pi/`.
 *
 * The PI packages are ordinary workspace members of this project, so their
 * dependencies (including the `tsgo` and `shx` build tools) come from the single
 * root `bun install` — there is no nested install step.
 *
 * PI's build scripts shell out to `node` and `npm`, so the toolchain provides two
 * shims on PATH:
 *   node -> Electron's bundled Node runtime (ELECTRON_RUN_AS_NODE)
 *   npm  -> `bun run` (so `npm run x` / `npm --prefix d run x` keep working)
 *
 * This builds PI's scripts unmodified without requiring a system Node/npm.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI = join(ROOT, "pi");
const TOOLCHAIN_BIN = join(tmpdir(), "nekocode-pi-toolchain", "bin");

export interface BuildStep {
	pkg: string;
	script: string;
}

/** Package build order matching PI's own `build:offline`. */
export function buildSteps(): BuildStep[] {
	return [
		{ pkg: "chord", script: "build" },
		{ pkg: "tui", script: "build" },
		{ pkg: "telemetry", script: "build" },
		{ pkg: "ai", script: "build:offline" },
		{ pkg: "agent", script: "build" },
		{ pkg: "session-backends/sqlite-node", script: "build" },
		{ pkg: "protocol", script: "build" },
		{ pkg: "client", script: "build" },
		{ pkg: "server", script: "build" },
		{ pkg: "coding-agent", script: "build" },
	];
}

/** Translate `npm run X ...` / `npm --prefix DIR run X ...` into bun args. */
export function translateNpmArgs(args: string[]): string[] | null {
	if (args[0] === "run") {
		return ["run", ...args.slice(1)];
	}
	if (args[0] === "--prefix" && args[2] === "run") {
		return ["run", "--cwd", args[1], ...args.slice(3)];
	}
	return null;
}

function writeToolchain(): string {
	if (process.platform === "win32") {
		throw new Error("pi-toolchain: Windows is not supported yet");
	}
	mkdirSync(TOOLCHAIN_BIN, { recursive: true });
	const electron = join(ROOT, "node_modules", "electron", "dist", "electron");
	if (!existsSync(electron)) {
		throw new Error(`Electron binary not found at ${electron}. Run \`bun install\` first.`);
	}
	writeFileSync(
		join(TOOLCHAIN_BIN, "node"),
		`#!/bin/bash\nELECTRON_RUN_AS_NODE=1 exec ${electron} "$@"\n`,
	);
	writeFileSync(
		join(TOOLCHAIN_BIN, "npm"),
		[
			"#!/bin/bash",
			'if [ "$1" = "run" ]; then shift; exec bun run "$@"; fi',
			'if [ "$1" = "--prefix" ] && [ "$3" = "run" ]; then dir="$2"; shift 3; exec bun run --cwd "$dir" "$@"; fi',
			'echo "npm-shim: unsupported invocation: npm $*" >&2',
			"exit 1",
			"",
		].join("\n"),
	);
	chmodSync(join(TOOLCHAIN_BIN, "node"), 0o755);
	chmodSync(join(TOOLCHAIN_BIN, "npm"), 0o755);
	return TOOLCHAIN_BIN;
}

function run(cmd: string, args: string[], extraPath?: string): void {
	const result = spawnSync(cmd, args, {
		stdio: "inherit",
		cwd: ROOT,
		env: extraPath
			? { ...process.env, PATH: `${extraPath}:${process.env.PATH ?? ""}` }
			: process.env,
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
	if (result.error) throw result.error;
}

function build(): void {
	const bin = writeToolchain();
	const aiData = join(PI, "packages", "ai", "src", "providers", "data");
	if (!existsSync(aiData)) {
		run("bun", ["run", "--cwd", join(PI, "packages", "ai"), "hydrate-model-data"], bin);
	}
	for (const step of buildSteps()) {
		run("bun", ["run", "--cwd", join(PI, "packages", step.pkg), step.script], bin);
	}
}

if (import.meta.main) {
	const mode = process.argv[2];
	if (mode === "build") {
		build();
	} else {
		console.error("usage: bun scripts/pi-toolchain.ts build");
		process.exit(1);
	}
}
