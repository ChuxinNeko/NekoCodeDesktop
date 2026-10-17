import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { safeStorage } from "electron";
import { validateSshHostInput, type SshHost, type SshStatus } from "../shared/ssh";

type Encryption = Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString" | "getSelectedStorageBackend">;

interface StoredHost extends Omit<SshHost, "hasSecret" | "hasVncPassword" | "vncPort"> {
	/** The password or key passphrase, encrypted with `safeStorage`, base64. */
	secret?: string;
	vncPort?: number | null;
	/** The VNC server's own password, encrypted the same way. */
	vncSecret?: string;
}

interface StoredFile {
	version: 1;
	hosts: StoredHost[];
}

/** A host with its secret decrypted, for opening a connection. Main only. */
export interface SshCredentials extends SshHost {
	secret: string | null;
	vncPassword: string | null;
}

const FILE = "ssh-hosts.json";

function isStoredHost(value: unknown): value is StoredHost {
	if (!value || typeof value !== "object") return false;
	const host = value as StoredHost;
	return (
		typeof host.id === "string" && !!host.id &&
		typeof host.name === "string" &&
		typeof host.host === "string" && !!host.host &&
		Number.isInteger(host.port) &&
		typeof host.username === "string" && !!host.username &&
		(host.auth === "password" || host.auth === "key") &&
		(host.desktopMode === undefined || host.desktopMode === "host" || host.desktopMode === "sandbox")
	);
}

/**
 * The SSH servers the user saved, in one file in app data.
 *
 * Passwords are encrypted with the OS keyring and never leave main; the
 * settings page learns only that one is set. Without a keyring a password
 * cannot be saved at all rather than being written in the clear — a key file
 * still works there, since only its path is stored.
 */
export class SshStore {
	private readonly path: string;
	private file: StoredFile | null = null;

	constructor(
		private readonly userDataDir: string,
		private readonly encryption: Encryption,
	) {
		this.path = join(userDataDir, FILE);
	}

	private canEncrypt(): boolean {
		return (
			this.encryption.isEncryptionAvailable() &&
			!(process.platform === "linux" && this.encryption.getSelectedStorageBackend() === "basic_text")
		);
	}

	private load(): StoredFile {
		if (this.file) return this.file;
		let hosts: StoredHost[] = [];
		if (existsSync(this.path)) {
			try {
				const value = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredFile> | null;
				if (Array.isArray(value?.hosts)) hosts = value.hosts.filter(isStoredHost);
			} catch {
				// Corrupt: no hosts, and the next save replaces it.
			}
		}
		this.file = { version: 1, hosts };
		return this.file;
	}

	private persist(next: StoredFile): void {
		mkdirSync(this.userDataDir, { recursive: true });
		const temporary = `${this.path}.tmp-${process.pid}`;
		try {
			writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
			renameSync(temporary, this.path);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
		this.file = next;
	}

	private decrypt(value: string | undefined): string | null {
		if (!value || !this.canEncrypt()) return null;
		try {
			return this.encryption.decryptString(Buffer.from(value, "base64"));
		} catch {
			// Encrypted under another OS account or a reset keyring: as good as unset.
			return null;
		}
	}

	private view({ secret, vncSecret, ...host }: StoredHost): SshHost {
		return {
			...host,
			privateKeyPath: host.privateKeyPath ?? null,
			remoteDir: host.remoteDir ?? null,
			fingerprint: host.fingerprint ?? null,
			hasSecret: !!secret,
			vncPort: host.vncPort ?? null,
			desktopMode: host.desktopMode === "sandbox" ? "sandbox" : "host",
			hasVncPassword: !!vncSecret,
		};
	}

	status(): SshStatus {
		return { hosts: this.load().hosts.map((host) => this.view(host)), canStoreSecrets: this.canEncrypt() };
	}

	hosts(): SshHost[] {
		return this.status().hosts;
	}

	/** A host by id, or by name when that is unambiguous — the agent names hosts. */
	find(ref: string): SshHost | null {
		const hosts = this.load().hosts;
		const byId = hosts.find((host) => host.id === ref);
		if (byId) return this.view(byId);
		const needle = ref.trim().toLowerCase();
		const matches = hosts.filter(
			(host) => host.name.toLowerCase() === needle || `${host.username}@${host.host}`.toLowerCase() === needle || host.host.toLowerCase() === needle,
		);
		return matches.length === 1 ? this.view(matches[0]) : null;
	}

	credentials(id: string): SshCredentials {
		const host = this.load().hosts.find((entry) => entry.id === id);
		if (!host) throw new Error(`Unknown SSH host: ${id}`);
		return { ...this.view(host), secret: this.decrypt(host.secret), vncPassword: this.decrypt(host.vncSecret) };
	}

	/** Add or update a host from the settings dialog. */
	save(raw: unknown): SshStatus {
		const input = validateSshHostInput(raw);
		const file = this.load();
		const current = input.id ? file.hosts.find((host) => host.id === input.id) : undefined;
		if (input.id && !current) throw new Error("That SSH host no longer exists");
		const encrypt = (value: string | undefined, stored: string | undefined): string | undefined => {
			if (value === undefined) return stored;
			if (!value) return undefined;
			if (!this.canEncrypt()) throw new Error("The system keyring is unavailable, so the password cannot be saved securely");
			return this.encryption.encryptString(value).toString("base64");
		};
		const secret = encrypt(input.secret, current?.secret);
		// A VNC password belongs to one VNC server; switching to the automatic one drops it.
		const vncSecret = input.vncPort === null ? undefined : encrypt(input.vncPassword, current?.vncSecret);
		if (input.auth === "password" && !secret) throw new Error("Enter the SSH password");
		// A different machine behind the same entry has a different host key.
		const sameServer = current && current.host === input.host && current.port === input.port;
		const next: StoredHost = {
			id: current?.id ?? randomUUID(),
			name: input.name,
			host: input.host,
			port: input.port,
			username: input.username,
			auth: input.auth,
			privateKeyPath: input.privateKeyPath ?? null,
			remoteDir: input.remoteDir ?? null,
			fingerprint: sameServer ? (current.fingerprint ?? null) : null,
			...(secret ? { secret } : {}),
			vncPort: input.vncPort ?? null,
			desktopMode: input.desktopMode ?? current?.desktopMode ?? "host",
			sandboxDir: input.sandboxDir ?? current?.sandboxDir,
			...(vncSecret ? { vncSecret } : {}),
		};
		this.persist({
			version: 1,
			hosts: current ? file.hosts.map((host) => (host.id === next.id ? next : host)) : [...file.hosts, next],
		});
		return this.status();
	}

	remove(id: string): SshStatus {
		const file = this.load();
		this.persist({ version: 1, hosts: file.hosts.filter((host) => host.id !== id) });
		return this.status();
	}

	/** Pin the host key seen on first connect, or clear it (null) so the next connect pins anew. */
	setFingerprint(id: string, fingerprint: string | null): SshStatus {
		const file = this.load();
		if (!file.hosts.some((host) => host.id === id)) throw new Error(`Unknown SSH host: ${id}`);
		this.persist({
			version: 1,
			hosts: file.hosts.map((host) => (host.id === id ? { ...host, fingerprint } : host)),
		});
		return this.status();
	}
}
