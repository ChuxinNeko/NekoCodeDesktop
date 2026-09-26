import type { App, safeStorage } from "electron";

type Encryption = Pick<
	typeof safeStorage,
	"isEncryptionAvailable" | "getSelectedStorageBackend" | "setUsePlainTextEncryption"
>;
type Relauncher = Pick<App, "isPackaged" | "relaunch" | "exit">;

export type KeyringOutcome =
	/** Not Linux, or the system keyring answered. */
	| "keyring"
	/** No keyring this session: secrets use Electron's local key (basic_text). */
	| "basic_text"
	/** The process is being replaced by one started with --password-store=basic. */
	| "relaunching"
	/** Nothing usable and nothing we may change — saving secrets will fail. */
	| "unavailable";

/**
 * Settle which safeStorage backend this session can actually use. Must run
 * right after `ready`, before anything encrypts or decrypts.
 *
 * Chromium picks the backend from the desktop environment, so a GNOME/XFCE
 * session reached over remote desktop still selects libsecret even when no
 * keyring daemon is reachable (or it stays locked) — and then refuses to
 * encrypt at all. The backend is fixed at startup, so the only way onto the
 * local key is to relaunch with --password-store=basic. That decision is made
 * per launch, never persisted: a local login with a working keyring keeps it,
 * and anything it stored stays readable there.
 */
export function settleLinuxKeyring(
	encryption: Encryption,
	app: Relauncher,
	options: { platform?: NodeJS.Platform; argv?: string[]; env?: NodeJS.ProcessEnv } = {},
): KeyringOutcome {
	const platform = options.platform ?? process.platform;
	const argv = options.argv ?? process.argv;
	const env = options.env ?? process.env;
	if (platform !== "linux") return "keyring";
	if (encryption.isEncryptionAvailable()) return "keyring";

	if (encryption.getSelectedStorageBackend() === "basic_text") {
		// Without this Electron refuses to use its local key on Linux. Stores
		// holding login sessions still reject basic_text on their own.
		encryption.setUsePlainTextEncryption(true);
		return encryption.isEncryptionAvailable() ? "basic_text" : "unavailable";
	}

	// The user chose a backend explicitly; overriding that is not ours to do.
	if (argv.some((arg) => arg === "--password-store" || arg.startsWith("--password-store="))) {
		return "unavailable";
	}
	// In dev the relaunched process would be orphaned from electron-vite.
	if (!app.isPackaged) {
		console.warn(
			`System keyring (${encryption.getSelectedStorageBackend()}) is unavailable; start with --password-store=basic to store API keys.`,
		);
		return "unavailable";
	}
	app.relaunch({
		// An AppImage's execPath lives in a mount that disappears with this process.
		...(env.APPIMAGE ? { execPath: env.APPIMAGE } : {}),
		args: [...argv.slice(1), "--password-store=basic"],
	});
	app.exit(0);
	return "relaunching";
}
