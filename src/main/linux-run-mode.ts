import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { posix } from "node:path";
import type { LinuxRunModeStatus } from "../shared/linux-run-mode";
import { PROFILE_BRIDGE_ENV, PROFILE_TOKEN_ENV, SHARED_PROFILE_ENV } from "../shared/linux-run-mode";

export const ROOT_SESSION_ENV = "NEKOCODE_ROOT_SESSION";
export const RETURN_TO_USER_EXIT_CODE = 42;
export const rootReadyMessage = (token: string): string => `NEKOCODE_ROOT_READY:${token}\n`;

/** No shell, user-supplied argv, profile directories, credentials or loader variables cross the boundary. */
export interface RootProfileLaunch { home: string; userData: string; bridge: string; token: string; path?: string }

export function rootLaunchArgs(executable: string, env: NodeJS.ProcessEnv, token: string, exists = existsSync, profile?: RootProfileLaunch): string[] {
	const display = env.DISPLAY;
	if (!display) throw new Error("Root mode requires an X11 or XWayland display (DISPLAY).");
	const defaultAuthority = env.HOME ? posix.join(env.HOME, ".Xauthority") : undefined;
	const authority = env.XAUTHORITY || (defaultAuthority && exists(defaultAuthority) ? defaultAuthority : undefined);
	return [
		"--disable-internal-agent", "--user", "root", "/usr/bin/env",
		`DISPLAY=${display}`,
		...(authority ? [`XAUTHORITY=${authority}`] : []),
		`${ROOT_SESSION_ENV}=${token}`,
		...(profile ? [`HOME=${profile.home}`, `${SHARED_PROFILE_ENV}=${profile.userData}`, `${PROFILE_BRIDGE_ENV}=${profile.bridge}`,
			`${PROFILE_TOKEN_ENV}=${profile.token}`, ...(profile.path ? [`PATH=${profile.path}`] : [])] : []),
		executable, "--no-sandbox", "--ozone-platform=x11", "--password-store=basic",
	];
}

interface RunModeOptions {
	platform: string;
	uid: number;
	user: string;
	packaged: boolean;
	executable: string;
	env: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
	spawn?: (args: string[]) => ChildProcess;
	onReady: () => void;
	onReturn: () => void;
	onExit: () => void;
	timeoutMs?: number;
	profile?: () => Promise<RootProfileLaunch>;
}

/** The original user process stays alive to own its preferences and restore its desktop session. */
export class LinuxRunModeService {
	private child: ChildProcess | null = null;
	private launching = false;
	private ready = false;
	constructor(private readonly options: RunModeOptions) {}

	focusRoot(): boolean {
		if (!this.child || !this.ready || !this.child.stdin?.writable) return false;
		this.child.stdin.write("show\n");
		return true;
	}

	status(): LinuxRunModeStatus {
		const o = this.options;
		const reason = !o.packaged ? "development" : !(o.exists ?? existsSync)("/usr/bin/pkexec") ? "pkexec" : !o.env.DISPLAY ? "display" : undefined;
		return {
			platform: o.platform, mode: o.uid === 0 ? "root" : "current", user: o.user,
			canElevate: o.platform === "linux" && o.uid !== 0 && !reason,
			canReturn: o.uid === 0 && Boolean(o.env[ROOT_SESSION_ENV]),
			unavailableReason: reason,
		};
	}

	async elevate(): Promise<void> {
		if (!this.status().canElevate) throw new Error("Root mode is unavailable on this desktop.");
		if (this.child || this.launching) throw new Error("A root instance is already running or starting.");
		this.launching = true;
		try {
			const profile = this.options.profile ? await this.options.profile() : undefined;
			await new Promise<void>((resolve, reject) => {
				const token = randomUUID();
				const args = rootLaunchArgs(this.options.executable, this.options.env, token, existsSync, profile);
				const child = this.options.spawn ? this.options.spawn(args) : spawn("/usr/bin/pkexec", args, {
					stdio: ["pipe", "pipe", "pipe"], cwd: "/",
					// pkexec sanitizes the target environment; sanitize its own launcher too.
					env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: this.options.env.LANG ?? "C.UTF-8" },
				});
				this.child = child;
				// A window activation can race the elevated process exiting.
				child.stdin?.on("error", () => {});
				let ready = false;
				let failed = false;
				let output = "";
				const fail = (error: Error) => {
					if (ready || failed) return;
					failed = true;
					clearTimeout(timer);
					reject(error);
				};
				const timer = setTimeout(() => {
					fail(new Error("Root startup timed out. The current user session is still available."));
					// Closing stdin also closes an elevated app that finishes starting late.
					child.stdin?.destroy();
					child.kill();
				}, this.options.timeoutMs ?? 120_000);
				child.stderr?.on("data", () => {}); // Drain without exposing process logs or secrets in the UI.
				child.stdout?.on("data", (data: Buffer) => {
					const combined = output + data.toString();
					const found = combined.includes(rootReadyMessage(token));
					output = combined.slice(-8192);
					if (ready || failed || !found) return;
					try {
						this.options.onReady();
						ready = true;
						this.ready = true;
						clearTimeout(timer);
						resolve();
					} catch (error) {
						fail(error instanceof Error ? error : new Error(String(error)));
						child.stdin?.destroy();
					}
				});
				child.once("error", (error) => { this.child = null; fail(error); });
				child.once("exit", (code) => {
					this.child = null;
					this.ready = false;
					clearTimeout(timer);
					if (!ready) {
						fail(new Error(code === 126 ? "Authorization was cancelled." : code === 127
							? "Authorization failed. Check the desktop polkit agent and administrator permissions."
							: "The root instance could not start. The current user session is still available."));
					} else if (code === RETURN_TO_USER_EXIT_CODE || code !== 0) this.options.onReturn();
					else this.options.onExit();
				});
			});
		} finally { this.launching = false; }
	}
}

export function currentLinuxIdentity(): { uid: number; user: string } {
	const user = userInfo();
	return { uid: process.getuid?.() ?? -1, user: user.username };
}
