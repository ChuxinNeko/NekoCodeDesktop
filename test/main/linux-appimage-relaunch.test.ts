import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { appImageRelaunchEnvironment, relaunchAppImage } from "../../src/main/linux-appimage-relaunch";

test("removes the previous FUSE mount without losing the desktop or user paths", () => {
	expect(appImageRelaunchEnvironment({
		APPDIR: "/tmp/.mount_neko", APPIMAGE: "/home/user/Neko.AppImage", ARGV0: "old", OWD: "/tmp",
		PATH: "/tmp/.mount_neko:/tmp/.mount_neko/usr/sbin:/home/user/.local/bin:/usr/bin",
		LD_LIBRARY_PATH: "/tmp/.mount_neko/usr/lib:/opt/user/lib", GSETTINGS_SCHEMA_DIR: "/tmp/.mount_neko/usr/share/schemas",
		XDG_DATA_DIRS: "/tmp/.mount_neko/usr/share:/usr/share", DISPLAY: ":10.0", XAUTHORITY: "/home/user/.Xauthority",
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1002/bus", HOME: "/home/user",
	})).toEqual({ PATH: "/home/user/.local/bin:/usr/bin", LD_LIBRARY_PATH: "/opt/user/lib", XDG_DATA_DIRS: "/usr/share",
		DISPLAY: ":10.0", XAUTHORITY: "/home/user/.Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1002/bus", HOME: "/home/user" });
});

test("waits outside Electron's sandbox and passes paths and arguments literally", () => {
	let call: { command: string; args: string[]; options: SpawnOptions } | undefined;
	let detached = false;
	const image = "/home/morax/Neko $(do-not-execute).AppImage";
	relaunchAppImage(image, ["--flag=quotes' and $value"], { HOME: "/home/morax" }, 123, (command, args, options) => {
		call = { command, args, options };
		return Object.assign(new EventEmitter(), { pid: 321, unref: () => { detached = true; } }) as unknown as ChildProcess;
	});
	expect(call!.command).toBe("/bin/sh");
	expect(call!.args.slice(2)).toEqual(["nekocode-relaunch", "123", image, "--flag=quotes' and $value"]);
	expect(call!.args[1]).not.toContain(image);
	expect(call!.options).toMatchObject({ cwd: "/", detached: true, stdio: "ignore" });
	expect(detached).toBe(true);
});
