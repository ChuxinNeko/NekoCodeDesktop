import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { safeStorage } from "electron";
import type { OAuthProviderId } from "../shared/settings";

/**
 * Tokens for providers the agent core does not know about.
 *
 * The core owns the credential for every provider it implements, and that is
 * where those belong. A provider ported here has no such home, so its tokens
 * live in this app — encrypted, because a refresh token is standing access to
 * the account, and beside the non-secret details the settings page needs to
 * name what is signed in.
 */

export interface StoredOAuthCredential {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

export interface StoredOAuthAccount {
	email?: string;
	/** Provider-specific workspace the credential is bound to. */
	projectId?: string;
	tier?: string;
	signedInAt: number;
}

interface StoredEntry extends StoredOAuthAccount {
	/** safeStorage-encrypted `StoredOAuthCredential`, base64. */
	secret: string;
	expiresAt: number;
}

interface CredentialFile {
	version: 1;
	credentials: Partial<Record<OAuthProviderId, StoredEntry>>;
}

const EMPTY: CredentialFile = { version: 1, credentials: {} };

export class OAuthCredentialStore {
	private readonly filePath: string;
	private file: CredentialFile | null = null;

	constructor(
		private readonly userDataDir: string,
		private readonly encryption: Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString" | "getSelectedStorageBackend">,
	) {
		this.filePath = join(userDataDir, "oauth-credentials.json");
	}

	private load(): CredentialFile {
		if (this.file) return this.file;
		if (!existsSync(this.filePath)) {
			this.file = { ...EMPTY, credentials: {} };
			return this.file;
		}
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
			const credentials = (parsed as CredentialFile | null)?.credentials;
			this.file =
				typeof credentials === "object" && credentials !== null
					? { version: 1, credentials }
					: { ...EMPTY, credentials: {} };
		} catch {
			// A damaged file means signing in again, which is recoverable; refusing
			// to start is not.
			this.file = { ...EMPTY, credentials: {} };
		}
		return this.file;
	}

	private persist(next: CredentialFile): void {
		mkdirSync(this.userDataDir, { recursive: true });
		const tmp = `${this.filePath}.tmp-${process.pid}`;
		try {
			writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, this.filePath);
		} catch (error) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				// best-effort cleanup of our own temp file
			}
			throw error;
		}
		this.file = next;
	}

	/** Non-secret details for the settings row; no decryption involved. */
	account(id: OAuthProviderId): (StoredOAuthAccount & { expiresAt: number }) | undefined {
		const entry = this.load().credentials[id];
		if (!entry) return undefined;
		const { secret: _secret, ...account } = entry;
		return account;
	}

	has(id: OAuthProviderId): boolean {
		return this.load().credentials[id] !== undefined;
	}

	read(id: OAuthProviderId): StoredOAuthCredential | undefined {
		const entry = this.load().credentials[id];
		if (!entry) return undefined;
		try {
			const decrypted = this.encryption.decryptString(Buffer.from(entry.secret, "base64"));
			const credential = JSON.parse(decrypted) as StoredOAuthCredential;
			if (typeof credential.accessToken !== "string" || !credential.accessToken.trim() ||
				typeof credential.refreshToken !== "string" || !credential.refreshToken.trim() ||
				!Number.isFinite(credential.expiresAt)) throw new Error("Invalid OAuth credential");
			return credential;
		} catch {
			throw new Error(`无法解密 ${id} 的登录凭据，请重新登录`);
		}
	}

	write(id: OAuthProviderId, credential: StoredOAuthCredential, account: StoredOAuthAccount): void {
		this.assertEncryptionAvailable();
		const secret = this.encryption.encryptString(JSON.stringify(credential)).toString("base64");
		const current = this.load();
		this.persist({
			version: 1,
			credentials: { ...current.credentials, [id]: { ...account, expiresAt: credential.expiresAt, secret } },
		});
	}

	assertEncryptionAvailable(): void {
		if (!this.encryption.isEncryptionAvailable() || (process.platform === "linux" && this.encryption.getSelectedStorageBackend() === "basic_text")) {
			throw new Error("系统密钥环不可用，无法安全保存登录凭据");
		}
	}

	delete(id: OAuthProviderId): void {
		const current = this.load();
		if (!current.credentials[id]) return;
		const credentials = { ...current.credentials };
		delete credentials[id];
		this.persist({ version: 1, credentials });
	}
}
