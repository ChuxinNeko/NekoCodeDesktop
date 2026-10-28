import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { LinuxRunModeService, rootLaunchArgs, rootReadyMessage, RETURN_TO_USER_EXIT_CODE } from "../../src/main/linux-run-mode";
import { sanitizePreferences } from "../../src/main/app-preferences";
import { isWebUiRpcMethod } from "../../src/shared/webui";

function fixture(overrides: Partial<ConstructorParameters<typeof LinuxRunModeService>[0]> = {}) {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
	});
	const calls = { ready: 0, returned: 0, exited: 0, args: [] as string[] };
	const service = new LinuxRunModeService({
		platform: "linux", uid: 1000, user: "morax", packaged: true, executable: "/opt/Neko Code/nekocode",
		env: { DISPLAY: ":0" }, exists: () => true,
		spawn: (args) => { calls.args = args; return child as unknown as ChildProcess; },
		onReady: () => { calls.ready++; }, onReturn: () => { calls.returned++; }, onExit: () => { calls.exited++; },
		...overrides,
	});
	const ready = () => {
		const token = calls.args.find((arg) => arg.startsWith("NEKOCODE_ROOT_SESSION="))!.split("=")[1]!;
		child.stdout.write(rootReadyMessage(token));
	};
	return { child, calls, service, ready };
}

describe("Linux application run mode", () => {
	test("launches with explicit safe arguments, never inherits credentials or user profile", () => {
		const args = rootLaunchArgs("/home/morax/Neko Code.AppImage", {
			DISPLAY: ":1", XAUTHORITY: "/home/morax/a file", HOME: "/home/morax", XDG_CONFIG_HOME: "/home/morax/.config",
			LD_PRELOAD: "/tmp/bad.so", NODE_OPTIONS: "--require=/tmp/bad.js", API_KEY: "secret",
		}, "token");
		expect(args).toEqual(["--disable-internal-agent", "--user", "root", "/usr/bin/env", "DISPLAY=:1",
			"XAUTHORITY=/home/morax/a file", "NEKOCODE_ROOT_SESSION=token", "/home/morax/Neko Code.AppImage",
			"--no-sandbox", "--ozone-platform=x11", "--password-store=basic"]);
	});
	test("does not silently guess a display", () => {
		expect(() => rootLaunchArgs("/opt/app", {}, "token")).toThrow("DISPLAY");
	});
	test("uses the desktop user's default Xauthority when no explicit path is exported", () => {
		const args = rootLaunchArgs("/opt/app", { DISPLAY: ":0", HOME: "/home/morax" }, "token",
			(path) => path === "/home/morax/.Xauthority");
		expect(args).toContain("XAUTHORITY=/home/morax/.Xauthority");
		expect(args.some((arg) => arg.startsWith("HOME="))).toBe(false);
	});
	test("detects the actual uid and whether a root session can return", () => {
		expect(fixture().service.status()).toMatchObject({ mode: "current", user: "morax", canElevate: true, canReturn: false });
		expect(fixture({ uid: 0, env: { NEKOCODE_ROOT_SESSION: "token" } }).service.status()).toMatchObject({ mode: "root", canReturn: true, canElevate: false });
		expect(fixture({ uid: 0 }).service.status().canReturn).toBe(false);
	});
	test.each([
		[{ packaged: false }, "development"], [{ exists: () => false }, "pkexec"], [{ env: {} }, "display"],
	] as const)("unavailable desktops provide a reason", (options, reason) => {
		expect(fixture(options).service.status()).toMatchObject({ canElevate: false, unavailableReason: reason });
	});
	test("does not elevate on Windows", async () => {
		await expect(fixture({ platform: "win32" }).service.elevate()).rejects.toThrow("unavailable");
	});
	test("waits for the matching root readiness marker before hiding or persisting", async () => {
		const f = fixture();
		const pending = f.service.elevate();
		f.child.stdout.write(rootReadyMessage("wrong-token"));
		expect(f.calls.ready).toBe(0);
		f.ready();
		await pending;
		expect(f.calls.ready).toBe(1);
		f.child.emit("exit", RETURN_TO_USER_EXIT_CODE);
		expect(f.calls.returned).toBe(1);
	});
	test("accepts a marker split across stdout chunks", async () => {
		const f = fixture();
		const pending = f.service.elevate();
		const token = f.calls.args.find((arg) => arg.startsWith("NEKOCODE_ROOT_SESSION="))!.split("=")[1]!;
		const marker = rootReadyMessage(token);
		f.child.stdout.write(marker.slice(0, 10));
		f.child.stdout.write(marker.slice(10));
		await pending;
		f.child.emit("exit", 0);
		expect(f.calls.exited).toBe(1);
	});
	test.each([126, 127, 1])("failed authorization/startup (%i) preserves the current session and allows retry", async (code) => {
		const f = fixture();
		const pending = f.service.elevate();
		f.child.emit("exit", code);
		await expect(pending).rejects.toThrow();
		expect(f.calls).toMatchObject({ ready: 0, returned: 0, exited: 0 });
		const retry = f.service.elevate();
		f.ready();
		await retry;
		f.child.emit("exit", 0);
	});
	test("rejects concurrent elevation and restores the user after a root crash", async () => {
		const f = fixture();
		const pending = f.service.elevate();
		await expect(f.service.elevate()).rejects.toThrow("already");
		f.ready();
		await pending;
		f.child.emit("exit", null);
		expect(f.calls.returned).toBe(1);
	});
	test("forwards focus to the root instance only after it is ready", async () => {
		const f = fixture();
		let input = "";
		f.child.stdin.on("data", (data: Buffer) => { input += data.toString(); });
		expect(f.service.focusRoot()).toBe(false);
		const pending = f.service.elevate();
		expect(f.service.focusRoot()).toBe(false);
		f.ready();
		await pending;
		expect(f.service.focusRoot()).toBe(true);
		expect(input).toBe("show\n");
		f.child.emit("exit", 0);
		expect(f.service.focusRoot()).toBe(false);
	});
	test("failed preference persistence leaves the user session active and closes root stdin", async () => {
		const f = fixture({ onReady: () => { throw new Error("read-only preferences"); } });
		const pending = f.service.elevate();
		f.ready();
		await expect(pending).rejects.toThrow("read-only preferences");
		expect(f.child.stdin.destroyed).toBe(true);
		expect(f.service.focusRoot()).toBe(false);
		f.child.emit("exit", 0);
	});
	test("times out without switching and closes the elevated session's stdin", async () => {
		const f = fixture({ timeoutMs: 5 });
		await expect(f.service.elevate()).rejects.toThrow("timed out");
		expect(f.calls.ready).toBe(0);
		expect(f.child.stdin.destroyed).toBe(true);
		f.child.emit("exit", 1);
	});
	test("persists only valid modes and exposes no remote switch RPC", () => {
		expect(sanitizePreferences({ linuxRunAs: "root" })).toEqual({ linuxRunAs: "root" });
		expect(sanitizePreferences({ linuxRunAs: "sudo" })).toEqual({});
		expect(isWebUiRpcMethod("linuxRunModeApply")).toBe(false);
		expect(isWebUiRpcMethod("linuxRunModeStatus")).toBe(false);
	});
});
