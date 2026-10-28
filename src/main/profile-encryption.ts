import { safeStorage as nativeSafeStorage } from "electron";
import { PROFILE_BRIDGE_ENV, PROFILE_TOKEN_ENV } from "./linux-profile-paths";
import { profileRequestSync } from "./linux-profile-bridge";

/** Root never changes the encryption format or keyring of the user's stored credentials. */
export const safeStorage: typeof nativeSafeStorage = new Proxy(nativeSafeStorage, {
	get(target, property) {
		const path = process.env[PROFILE_BRIDGE_ENV];
		const token = process.env[PROFILE_TOKEN_ENV];
		if (process.platform === "linux" && process.getuid?.() === 0 && path && token) {
			if (property === "encryptString") return (value: string) => Buffer.from(profileRequestSync(path, token, "encrypt", value) as string, "base64");
			if (property === "decryptString") return (value: Buffer) => profileRequestSync(path, token, "decrypt", value.toString("base64")) as string;
			if (property === "isEncryptionAvailable") return () => (profileRequestSync(path, token, "status") as { available: boolean }).available;
			if (property === "getSelectedStorageBackend") return () => (profileRequestSync(path, token, "status") as { backend: string }).backend;
		}
		const value = Reflect.get(target, property);
		return typeof value === "function" ? value.bind(target) : value;
	},
});
