import { describe, expect, test } from "bun:test";
import { settleLinuxKeyring } from "./linux-keyring";

type Backend = "basic_text" | "gnome_libsecret" | "kwallet6";

function fakeEncryption(backend: Backend, keyringUp: boolean) {
	let plainText = false;
	return {
		get plainText() {
			return plainText;
		},
		getSelectedStorageBackend: () => backend,
		// Mirrors Electron: the local key only counts on the basic_text backend.
		isEncryptionAvailable: () => keyringUp || (plainText && backend === "basic_text"),
		setUsePlainTextEncryption: (value: boolean) => {
			plainText = value;
		},
	};
}

function fakeApp(isPackaged = true) {
	const calls = { relaunch: [] as unknown[], exit: [] as unknown[] };
	return {
		calls,
		isPackaged,
		relaunch: (options?: unknown) => void calls.relaunch.push(options),
		exit: (code?: number) => void calls.exit.push(code),
	};
}

const argv = ["/opt/NekoCode/nekocode", "--no-sandbox"];

describe("settleLinuxKeyring", () => {
	test("leaves other platforms alone", () => {
		const encryption = fakeEncryption("basic_text", false);
		const app = fakeApp();
		expect(settleLinuxKeyring(encryption, app, { platform: "win32", argv, env: {} })).toBe("keyring");
		expect(encryption.plainText).toBe(false);
		expect(app.calls.relaunch).toEqual([]);
	});

	test("keeps a working keyring", () => {
		const app = fakeApp();
		expect(settleLinuxKeyring(fakeEncryption("gnome_libsecret", true), app, { platform: "linux", argv, env: {} })).toBe("keyring");
		expect(app.calls.relaunch).toEqual([]);
	});

	test("falls back to the local key when the backend is already basic_text", () => {
		const encryption = fakeEncryption("basic_text", false);
		const app = fakeApp();
		expect(settleLinuxKeyring(encryption, app, { platform: "linux", argv, env: {} })).toBe("basic_text");
		expect(encryption.plainText).toBe(true);
		expect(app.calls.relaunch).toEqual([]);
	});

	test("relaunches onto basic_text when the selected keyring is unreachable", () => {
		const app = fakeApp();
		expect(settleLinuxKeyring(fakeEncryption("gnome_libsecret", false), app, { platform: "linux", argv, env: {} })).toBe("relaunching");
		expect(app.calls.relaunch).toEqual([{ args: ["--no-sandbox", "--password-store=basic"] }]);
		expect(app.calls.exit).toEqual([0]);
	});

	test("an AppImage relaunches through the image, not its temporary mount", () => {
		const app = fakeApp();
		settleLinuxKeyring(fakeEncryption("kwallet6", false), app, {
			platform: "linux",
			argv,
			env: { APPIMAGE: "/home/neko/NekoCode.AppImage" },
		});
		expect(app.calls.relaunch).toEqual([
			{ execPath: "/home/neko/NekoCode.AppImage", args: ["--no-sandbox", "--password-store=basic"] },
		]);
	});

	test("respects an explicit --password-store", () => {
		const app = fakeApp();
		const explicit = [...argv, "--password-store=gnome-libsecret"];
		expect(settleLinuxKeyring(fakeEncryption("gnome_libsecret", false), app, { platform: "linux", argv: explicit, env: {} })).toBe("unavailable");
		expect(app.calls.relaunch).toEqual([]);
	});

	test("does not relaunch an unpackaged dev build", () => {
		const app = fakeApp(false);
		expect(settleLinuxKeyring(fakeEncryption("gnome_libsecret", false), app, { platform: "linux", argv, env: {} })).toBe("unavailable");
		expect(app.calls.relaunch).toEqual([]);
	});
});
