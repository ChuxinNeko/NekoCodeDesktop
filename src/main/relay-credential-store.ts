import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { safeStorage } from "electron";
import type { RelayIdentity } from "../shared/relay";
import { generateRelayIdentity, validateRelayIdentity } from "../shared/relay-crypto";

export interface RelayAccountSession {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	user: { id: string; email: string };
}

interface IdentityEntry {
	id: string;
	publicKey: string;
	secret: string;
}

interface AccountEntry {
	email: string;
	userId: string;
	expiresAt: number;
	secret: string;
}

interface CredentialFile {
	version: 1;
	identity?: IdentityEntry;
	account?: AccountEntry;
}

const EMPTY: CredentialFile = { version: 1 };

export class RelayCredentialStore {
	private readonly filePath: string;
	private file: CredentialFile | null = null;

	constructor(
		private readonly userDataDir: string,
		private readonly encryption: Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString" | "getSelectedStorageBackend">,
	) {
		this.filePath = join(userDataDir, "relay-credentials.json");
	}

	private load(): CredentialFile {
		if (this.file) return this.file;
		if (!existsSync(this.filePath)) {
			this.file = { version: 1 };
			return this.file;
		}
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as CredentialFile | null;
			this.file = parsed?.version === 1 ? { version: 1, identity: parsed.identity, account: parsed.account } : { version: 1 };
		} catch {
			this.file = { version: 1 };
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
			} catch {}
			throw error;
		}
		this.file = next;
	}

	private assertEncryptionAvailable(): void {
		if (!this.encryption.isEncryptionAvailable() || (process.platform === "linux" && this.encryption.getSelectedStorageBackend() === "basic_text")) {
			throw new Error("系统密钥环不可用，无法安全保存公网连接凭据");
		}
	}

	async identity(): Promise<RelayIdentity> {
		this.assertEncryptionAvailable();
		const file = this.load();
		const entry = file.identity;
		if (entry && typeof entry.id === "string" && typeof entry.publicKey === "string" && typeof entry.secret === "string") {
			try {
				const privateKey = this.encryption.decryptString(Buffer.from(entry.secret, "base64"));
				const identity = await validateRelayIdentity({ version: 1, id: entry.id, publicKey: entry.publicKey, privateKey });
				if (identity) return identity;
			} catch {}
		}
		const identity = await generateRelayIdentity();
		this.persist({
			version: 1,
			identity: {
				id: identity.id,
				publicKey: identity.publicKey,
				secret: this.encryption.encryptString(identity.privateKey).toString("base64"),
			},
			...(file.account ? { account: file.account } : {}),
		});
		return identity;
	}

	account(): RelayAccountSession | null {
		const entry = this.load().account;
		if (!entry) return null;
		try {
			const session = JSON.parse(this.encryption.decryptString(Buffer.from(entry.secret, "base64"))) as RelayAccountSession;
			if (
				typeof session.accessToken !== "string" || !session.accessToken || session.accessToken.length > 4096 ||
				typeof session.refreshToken !== "string" || !session.refreshToken || session.refreshToken.length > 4096 ||
				!Number.isFinite(session.expiresAt) ||
				typeof session.user?.id !== "string" || !session.user.id ||
				typeof session.user?.email !== "string" || !session.user.email
			) return null;
			return session;
		} catch {
			return null;
		}
	}

	writeAccount(session: RelayAccountSession): void {
		this.assertEncryptionAvailable();
		const current = this.load();
		this.persist({
			version: 1,
			...(current.identity ? { identity: current.identity } : {}),
			account: {
				email: session.user.email,
				userId: session.user.id,
				expiresAt: session.expiresAt,
				secret: this.encryption.encryptString(JSON.stringify(session)).toString("base64"),
			},
		});
	}

	clearAccount(): void {
		const current = this.load();
		if (!current.account) return;
		this.persist({ version: 1, ...(current.identity ? { identity: current.identity } : {}) });
	}
}
