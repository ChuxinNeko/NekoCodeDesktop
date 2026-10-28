import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** Drop paths into the old FUSE mount while preserving the user's own environment. */
export function appImageRelaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const next = { ...env };
	const directory = env.APPDIR?.replace(/\/+$/, "");
	if (directory) {
		for (const key of ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"]) {
			if (next[key] === undefined) continue;
			const value = next[key]!.split(":").filter((path) => path !== directory && !path.startsWith(`${directory}/`)).join(":");
			if (value) next[key] = value; else delete next[key];
		}
	}
	for (const key of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete next[key];
	return next;
}

// Arguments are positional and quoted. No path, argument or environment value is shell source.
const WAIT_AND_EXEC = 'n=0; while kill -0 "$1" 2>/dev/null; do n=$((n+1)); [ "$n" -ge 300 ] && exit 1; /bin/sleep 0.1; done; shift; exec "$@"';
type Launcher = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Electron's native relauncher sets no_new_privs, which prevents fusermount from mounting an AppImage. */
export function relaunchAppImage(image: string, args: string[], env: NodeJS.ProcessEnv, pid = process.pid, launch: Launcher = spawn): void {
	const child = launch("/bin/sh", ["-c", WAIT_AND_EXEC, "nekocode-relaunch", String(pid), image, ...args], {
		cwd: "/", env: appImageRelaunchEnvironment(env), detached: true, stdio: "ignore",
	});
	child.on("error", () => {});
	if (!child.pid) throw new Error("Could not start the AppImage relaunch helper");
	child.unref();
}
