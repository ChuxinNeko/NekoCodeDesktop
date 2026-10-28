import { spawnSync } from "node:child_process";

type DisplayCommand = (args: string[], env: NodeJS.ProcessEnv) => { status: number | null; stdout: string };

/** Chromium's graphics children may open X11 without the parent's authority cookie. */
export function authorizeRootDisplay(env: NodeJS.ProcessEnv, run: DisplayCommand = (args, environment) =>
	spawnSync("/usr/bin/xhost", args, { env: environment, encoding: "utf8", timeout: 5000, windowsHide: true })): () => void {
	if (!env.DISPLAY) throw new Error("Root graphics require an X11 display.");
	const environment: NodeJS.ProcessEnv = {
		PATH: "/usr/bin:/bin", LANG: "C", DISPLAY: env.DISPLAY,
		...(env.XAUTHORITY ? { XAUTHORITY: env.XAUTHORITY } : {}),
		...(env.HOME ? { HOME: env.HOME } : {}),
	};
	const current = run([], environment);
	if (current.status !== 0) throw new Error("Cannot authorize root graphics. Check xhost (x11-xserver-utils) and the desktop's X11 authorization.");
	if (/^\s*SI:localuser:root\s*$/m.test(current.stdout)) return () => {};
	if (run(["+SI:localuser:root"], environment).status !== 0) throw new Error("The desktop refused graphics access for the local root user.");
	let released = false;
	return () => {
		if (released) return;
		released = true;
		run(["-SI:localuser:root"], environment);
	};
}
