export type SshAuthMethod = "password" | "key";
export type SshDesktopMode = "host" | "sandbox";
export const SANDBOX_HOME = "/home/neko";
export const SANDBOX_WORKSPACE = `${SANDBOX_HOME}/workspace`;

export interface SandboxDeployment {
	hostId: string;
	phase: "checking" | "dependencies" | "runtime" | "image" | "network" | "ready" | "error";
	error?: string;
}

/**
 * A saved SSH server, as the settings page and the terminal see it. Secrets
 * never cross into the renderer: it learns only whether one is stored.
 */
export interface SshHost {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	auth: SshAuthMethod;
	/** A private key file on this machine; used when `auth` is "key". */
	privateKeyPath: string | null;
	/** Where commands run and relative remote paths resolve; the login directory when null. */
	remoteDir: string | null;
	/** SHA256 of the server's host key, pinned on first connect. */
	fingerprint: string | null;
	/** A password (or a key passphrase) is saved. */
	hasSecret: boolean;
	/**
	 * The remote desktop: an existing VNC server's port on the host, or null to
	 * start x11vnc on the logged-in X display on demand.
	 */
	vncPort: number | null;
	hasVncPassword: boolean;
	/** Missing on legacy hosts: use the existing host desktop. Sandbox routes all SSH work into gVisor. */
	desktopMode?: SshDesktopMode;
	sandboxDir?: string;
}

/**
 * A host as the settings dialog submits it. An absent `secret` keeps the
 * stored one, an empty string clears it; an absent `id` adds a new host.
 */
export interface SshHostInput {
	id?: string;
	name: string;
	host: string;
	port: number;
	username: string;
	auth: SshAuthMethod;
	privateKeyPath?: string | null;
	remoteDir?: string | null;
	secret?: string;
	vncPort?: number | null;
	/** Same rule as `secret`: absent keeps, empty clears. */
	vncPassword?: string;
	desktopMode?: SshDesktopMode;
	sandboxDir?: string;
}

export interface SshStatus {
	hosts: SshHost[];
	/** The OS keyring works; without it no password can be saved. */
	canStoreSecrets: boolean;
}

export interface SshTestResult {
	fingerprint: string;
	/** `uname -srm` or the like, when the server answered it. */
	system: string | null;
}

export const SSH_DEFAULT_PORT = 22;
export const MAX_SSH_SECRET_LENGTH = 4096;

/** The dialog's input, checked field by field because it arrives over IPC. */
export function validateSshHostInput(value: unknown): SshHostInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid SSH host");
	const input = value as Record<string, unknown>;
	const text = (key: string, max: number, required: boolean): string => {
		const raw = input[key];
		const trimmed = typeof raw === "string" ? raw.trim() : "";
		if (required && !trimmed) throw new Error(`SSH host ${key} is required`);
		if (trimmed.length > max) throw new Error(`SSH host ${key} is too long`);
		return trimmed;
	};
	const optional = (key: string, max: number): string | null => {
		if (input[key] === undefined || input[key] === null) return null;
		return text(key, max, false) || null;
	};
	const host = text("host", 255, true);
	if (/\s|[/@]/.test(host)) throw new Error("The SSH host must be a bare hostname or IP address");
	const port = input.port === undefined ? SSH_DEFAULT_PORT : Number(input.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The SSH port must be 1–65535");
	const auth = input.auth;
	if (auth !== "password" && auth !== "key") throw new Error("Unknown SSH authentication method");
	const secret = input.secret;
	if (secret !== undefined && (typeof secret !== "string" || secret.length > MAX_SSH_SECRET_LENGTH))
		throw new Error("Invalid SSH password");
	const id = input.id;
	if (id !== undefined && (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(id))) throw new Error("Invalid SSH host id");
	const privateKeyPath = optional("privateKeyPath", 4096);
	if (auth === "key" && !privateKeyPath) throw new Error("Choose a private key file");
	const username = text("username", 255, true);
	const vncPort = input.vncPort === undefined || input.vncPort === null || input.vncPort === "" ? null : Number(input.vncPort);
	if (vncPort !== null && (!Number.isInteger(vncPort) || vncPort < 1 || vncPort > 65535)) throw new Error("The VNC port must be 1–65535");
	const vncPassword = input.vncPassword;
	if (input.desktopMode !== undefined && input.desktopMode !== "host" && input.desktopMode !== "sandbox")
		throw new Error("Invalid desktop environment");
	const sandboxDir = optional("sandboxDir", 4096) ?? SANDBOX_WORKSPACE;
	if (!sandboxDir.startsWith("/") || sandboxDir.includes("\0")) throw new Error("Sandbox directory must be an absolute Linux path");
	if (vncPassword !== undefined && (typeof vncPassword !== "string" || vncPassword.length > MAX_SSH_SECRET_LENGTH))
		throw new Error("Invalid VNC password");
	return {
		...(id !== undefined ? { id } : {}),
		name: text("name", 120, false) || `${username}@${host}`,
		host,
		port,
		username,
		auth,
		privateKeyPath: auth === "key" ? privateKeyPath : null,
		remoteDir: optional("remoteDir", 4096),
		...(secret !== undefined ? { secret } : {}),
		vncPort,
		...(input.desktopMode !== undefined ? { desktopMode: input.desktopMode } : {}),
		...(input.sandboxDir !== undefined ? { sandboxDir } : {}),
		...(vncPassword !== undefined ? { vncPassword } : {}),
	};
}
