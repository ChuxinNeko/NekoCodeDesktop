import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
 *
 * On Windows the shims are `.cmd` files: cmd.exe ignores shebangs, and neither
 * Bun Shell nor `spawn` will pick up an extensionless script off PATH.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI = join(ROOT, "pi");
const SELF = fileURLToPath(import.meta.url);
const IS_WINDOWS = process.platform === "win32";
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

const ELECTRON_PKG = join(ROOT, "node_modules", "electron");

/** Where `require("electron")` would look right now, per the installer's path.txt. */
function electronBinaryPath(): string {
	const pathFile = join(ELECTRON_PKG, "path.txt");
	const relative = existsSync(pathFile)
		? readFileSync(pathFile, "utf8").trim()
		: IS_WINDOWS
			? "electron.exe"
			: "electron";
	return join(ELECTRON_PKG, "dist", relative);
}

/**
 * Resolve Electron's executable the way `require("electron")` does, downloading
 * the dist if it is missing.
 *
 * Electron has no postinstall script anymore, so `bun install` leaves
 * `node_modules/electron/dist/` empty; the download happens lazily on the first
 * `require("electron")`. Nothing here requires the module (the shims only need
 * the path), so the download has to be kicked off explicitly.
 */
function electronBinary(): string {
	const existing = electronBinaryPath();
	if (existsSync(existing)) return existing;

	const installer = join(ELECTRON_PKG, "install.js");
	if (!existsSync(installer)) {
		throw new Error(`Electron is not installed at ${ELECTRON_PKG}. Run \`bun install\` first.`);
	}
	console.log("Downloading the Electron binary...");
	const result = spawnSync(process.execPath, [installer], { stdio: "inherit", cwd: ROOT });
	if (result.error) throw result.error;

	const binary = electronBinaryPath();
	if (result.status !== 0 || !existsSync(binary)) {
		throw new Error(
			`Electron binary not found at ${binary} and the download failed. ` +
				`Run \`bun ${installer}\` manually (set ELECTRON_MIRROR if the download is blocked).`,
		);
	}
	return binary;
}

function writeWindowsToolchain(electron: string): void {
	writeFileSync(
		join(TOOLCHAIN_BIN, "node.cmd"),
		[
			"@echo off",
			"setlocal",
			'set "ELECTRON_RUN_AS_NODE=1"',
			`"${electron}" %*`,
			"exit /b %errorlevel%",
			"",
		].join("\r\n"),
	);
	// Batch makes arg shuffling painful, so the shim calls back into this script
	// and reuses `translateNpmArgs` instead of reimplementing it.
	writeFileSync(
		join(TOOLCHAIN_BIN, "npm.cmd"),
		[
			"@echo off",
			`"${process.execPath}" "${SELF}" npm-shim %*`,
			"exit /b %errorlevel%",
			"",
		].join("\r\n"),
	);
}

function writeToolchain(): string {
	mkdirSync(TOOLCHAIN_BIN, { recursive: true });
	const electron = electronBinary();
	if (IS_WINDOWS) {
		writeWindowsToolchain(electron);
		return TOOLCHAIN_BIN;
	}
	writeFileSync(
		join(TOOLCHAIN_BIN, "node"),
		`#!/bin/bash\nELECTRON_RUN_AS_NODE=1 exec "${electron}" "$@"\n`,
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

/**
 * Prepend `extra` to PATH. Windows spells the variable `Path`, and adding a
 * second `PATH` key next to it leaves which one wins up to the child process.
 */
function withPath(extra: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	env[key] = `${extra}${delimiter}${env[key] ?? ""}`;
	return env;
}

function run(cmd: string, args: string[], opts: { cwd?: string; extraPath?: string } = {}): void {
	const result = spawnSync(cmd, args, {
		stdio: "inherit",
		cwd: opts.cwd ?? ROOT,
		env: opts.extraPath ? withPath(opts.extraPath) : process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function build(): void {
	const bin = writeToolchain();
	const aiData = join(PI, "packages", "ai", "src", "providers", "data");
	if (!existsSync(aiData)) {
		run("bun", ["run", "--cwd", join(PI, "packages", "ai"), "hydrate-model-data"], {
			extraPath: bin,
		});
	}
	for (const step of buildSteps()) {
		run("bun", ["run", "--cwd", join(PI, "packages", step.pkg), step.script], { extraPath: bin });
	}
}

/** `npm.cmd` entry point: run the translated command in the caller's directory. */
function npmShim(args: string[]): void {
	const translated = translateNpmArgs(args);
	if (!translated) {
		console.error(`npm-shim: unsupported invocation: npm ${args.join(" ")}`);
		process.exit(1);
	}
	run("bun", translated, { cwd: process.cwd() });
}

if (import.meta.main) {
	const mode = process.argv[2];
	if (mode === "build") {
		build();
	} else if (mode === "npm-shim") {
		npmShim(process.argv.slice(3));
	} else {
		console.error("usage: bun scripts/pi-toolchain.ts build");
		process.exit(1);
	}
}
