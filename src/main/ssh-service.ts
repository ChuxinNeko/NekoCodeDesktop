import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { posix } from "node:path";
import type { Client, ClientChannel, ConnectConfig, SFTPWrapper } from "ssh2";
import { SANDBOX_WORKSPACE, type SshTestResult, type SandboxDeployment } from "../shared/ssh";
import type { SshCredentials, SshStore } from "./ssh-store";
import { DesktopSandbox } from "./desktop-sandbox";
import { shellQuote, shellQuotePath } from "./posix-shell";
export { shellQuote, shellQuotePath } from "./posix-shell";

/** Directories a directory upload leaves behind: history and installable dependencies, not a deployment. */
export const SKIPPED_UPLOAD_DIRS = new Set([".git", "node_modules"]);
const MAX_TRANSFER_FILES = 10_000;
const MAX_STREAM_BYTES = 1024 * 1024;
const IDLE_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 20_000;
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 30 * 60_000;

export interface SshExecResult {
	code: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Bytes dropped from the front of stdout and stderr to stay under the cap. */
	truncated: number;
}

export interface SshEntry {
	name: string;
	type: "file" | "directory" | "symlink" | "other";
	size: number;
	modified: number;
}

export interface SshTransferResult {
	files: number;
	bytes: number;
	/** Where it went, absolute on the remote side for uploads. */
	target: string;
	skipped: string[];
}

/** OpenSSH's form: `SHA256:` and unpadded base64 of the raw host key. */
export function hostKeyFingerprint(key: Buffer): string {
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** Where a remote command runs: an explicit cwd, resolved against the host's directory when relative. */
export function remoteCwd(remoteDir: string | null, cwd: string | undefined): string | null {
	const dir = cwd?.trim();
	if (!dir) return remoteDir;
	if (dir.startsWith("/") || dir === "~" || dir.startsWith("~/") || !remoteDir) return dir;
	return posix.join(remoteDir, dir);
}

export function expandLocalHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
}

/** The handshake's failures, in words that say what to fix. */
export function describeSshError(error: unknown, host: Pick<SshCredentials, "host" | "port" | "username">): Error {
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as { code?: string } | null)?.code;
	const where = `${host.username}@${host.host}:${host.port}`;
	if (/authentication methods failed/i.test(message))
		return new Error(`SSH authentication failed for ${where}: check the username and password (or key)`);
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new Error(`SSH host not found: ${host.host}`);
	if (code === "ECONNREFUSED") return new Error(`SSH connection refused by ${host.host}:${host.port} — is sshd running on that port?`);
	if (code === "ETIMEDOUT" || /timed out/i.test(message)) return new Error(`SSH connection to ${host.host}:${host.port} timed out`);
	if (/encrypted private key|passphrase/i.test(message)) return new Error("The private key is encrypted: save its passphrase with the host");
	return new Error(`SSH ${where}: ${message}`);
}

/** Keeps the tail of a stream, dropping from the front past the cap. */
class TailBuffer {
	private chunks: Buffer[] = [];
	private size = 0;
	dropped = 0;
	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.size += chunk.length;
		while (this.size > MAX_STREAM_BYTES && this.chunks.length) {
			const head = this.chunks[0];
			const excess = this.size - MAX_STREAM_BYTES;
			if (head.length <= excess) {
				this.chunks.shift();
				this.size -= head.length;
				this.dropped += head.length;
			} else {
				this.chunks[0] = head.subarray(excess);
				this.size -= excess;
				this.dropped += excess;
			}
		}
	}
	text(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

interface Pooled {
	ready: Promise<Client>;
	idle?: ReturnType<typeof setTimeout>;
	users: number;
}

type Ssh2 = typeof import("ssh2");
let ssh2: Promise<Ssh2> | null = null;
const loadSsh2 = () => (ssh2 ??= import("ssh2"));

function sftpCall<T>(run: (done: (error: Error | null | undefined, value?: T) => void) => void): Promise<T> {
	return new Promise((resolve, reject) => run((error, value) => (error ? reject(error) : resolve(value as T))));
}

/**
 * SSH for the agent, the terminal and the settings page, in-process on ssh2 —
 * no ssh client needs to be installed, and a password works where OpenSSH
 * would insist on a terminal to type it into.
 *
 * Host keys are trusted on first use: the fingerprint seen on the first
 * connection is pinned to the saved host, and a later connection presenting a
 * different key is refused until the user clears the pin in settings.
 *
 * Connections are pooled per host and closed after five idle minutes, so a
 * run of commands does not pay a handshake each.
 */
export class SshService {
	private pool = new Map<string, Pooled>();
	private sandbox: DesktopSandbox;
	private generations = new Map<string, number>();
	private deployments = new Map<string, SandboxDeployment>();

	constructor(private readonly store: SshStore, private readonly deploymentReporter?: (state: SandboxDeployment) => void) {
		this.sandbox = new DesktopSandbox(state => this.reportDeployment(state));
	}
	private reportDeployment(state: SandboxDeployment): void {
		this.deployments.set(state.hostId, state);
		this.deploymentReporter?.(state);
	}
	sandboxDeployments(): SandboxDeployment[] { return [...this.deployments.values()]; }

	async prepareSandbox(hostId: string): Promise<void> {
		const credentials = this.store.credentials(hostId);
		if (credentials.desktopMode !== "sandbox") throw new Error("This server is not configured for a sandbox");
		this.generations.set(hostId, this.generations.get(hostId) ?? 0);
		this.reportDeployment({ hostId, phase: "checking" });
		try { await this.sandbox.prepare(hostId, () => this.openHost(credentials)); }
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("connection cancelled")) this.reportDeployment({ hostId, phase: "error", error: message });
			throw error;
		}
	}

	private async open(credentials: SshCredentials): Promise<Client> {
		const generation = this.generations.get(credentials.id) ?? 0;
		this.generations.set(credentials.id, generation);
		const outer = await this.openHost(credentials);
		if (generation !== (this.generations.get(credentials.id) ?? 0)) { outer.end(); throw new Error("SSH connection cancelled"); }
		return credentials.desktopMode === "sandbox" ? this.sandbox.connect(credentials, outer) : outer;
	}

	private environmentCredentials(hostId: string): SshCredentials {
		const credentials = this.store.credentials(hostId);
		return credentials.desktopMode === "sandbox"
			? { ...credentials, remoteDir: credentials.sandboxDir ?? SANDBOX_WORKSPACE, vncPort: 5900, vncPassword: null }
			: credentials;
	}

	/** The settings probe and sandbox lifecycle are the only callers allowed to use a host shell. */
	private async openHost(credentials: SshCredentials): Promise<Client> {
		const { Client } = await loadSsh2();
		const client = new Client();
		let seen: string | null = null;
		const config: ConnectConfig = {
			host: credentials.host,
			port: credentials.port,
			username: credentials.username,
			readyTimeout: READY_TIMEOUT_MS,
			keepaliveInterval: 15_000,
			keepaliveCountMax: 4,
			tryKeyboard: credentials.auth === "password",
			hostVerifier: (key: Buffer) => {
				seen = hostKeyFingerprint(key);
				return !credentials.fingerprint || credentials.fingerprint === seen;
			},
		};
		if (credentials.auth === "password") config.password = credentials.secret ?? "";
		else {
			const keyPath = expandLocalHome(credentials.privateKeyPath ?? "");
			try {
				config.privateKey = readFileSync(keyPath);
			} catch {
				throw new Error(`Cannot read the SSH private key at ${keyPath}`);
			}
			if (credentials.secret) config.passphrase = credentials.secret;
		}
		// Servers that only offer keyboard-interactive still just want the password.
		client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) =>
			finish(prompts.map(() => credentials.secret ?? "")),
		);
		await new Promise<void>((resolve, reject) => {
			client.once("ready", () => resolve());
			client.once("error", (error) => {
				if (seen && credentials.fingerprint && seen !== credentials.fingerprint)
					reject(new Error(
						`The host key of ${credentials.host} changed (expected ${credentials.fingerprint}, got ${seen}). ` +
							"If the server was reinstalled, clear the saved host key in Settings → SSH; otherwise do not connect.",
					));
				else reject(describeSshError(error, credentials));
			});
			try {
				client.connect(config);
			} catch (error) {
				reject(describeSshError(error, credentials));
			}
		});
		// Later errors (a dropped link) surface through the next call; keep them from being unhandled.
		client.on("error", () => {});
		if (!credentials.fingerprint && seen) this.store.setFingerprint(credentials.id, seen);
		return client;
	}

	/** A pooled connection, held until `release`. */
	private async acquire(hostId: string): Promise<{ client: Client; release: () => void }> {
		let entry = this.pool.get(hostId);
		if (!entry) {
			const created: Pooled = { users: 0, ready: this.open(this.store.credentials(hostId)) };
			entry = created;
			this.pool.set(hostId, created);
			created.ready.then(
				(client) => client.on("close", () => {
					if (this.pool.get(hostId) === created) this.pool.delete(hostId);
				}),
				() => {
					if (this.pool.get(hostId) === created) this.pool.delete(hostId);
				},
			);
		}
		const held = entry;
		if (held.idle) clearTimeout(held.idle);
		held.idle = undefined;
		held.users++;
		let client: Client;
		try {
			client = await held.ready;
		} catch (error) {
			held.users--;
			throw error;
		}
		let released = false;
		return {
			client,
			release: () => {
				if (released) return;
				released = true;
				if (--held.users > 0 || this.pool.get(hostId) !== held) return;
				held.idle = setTimeout(() => this.dropPool(hostId), IDLE_MS);
				held.idle.unref?.();
			},
		};
	}

	/** Drop a host's pooled connection — after it is edited or removed, or on quit. */
	disconnect(hostId: string): void {
		this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
		this.sandbox.disconnect(hostId);
		this.dropPool(hostId);
	}

	private dropPool(hostId: string): void {
		const entry = this.pool.get(hostId);
		if (!entry) return;
		this.pool.delete(hostId);
		if (entry.idle) clearTimeout(entry.idle);
		entry.ready.then((client) => client.end(), () => {});
	}

	disconnectAll(): void {
		for (const id of new Set([...this.pool.keys(), ...this.generations.keys()])) this.disconnect(id);
	}

	private async withClient<T>(hostId: string, run: (client: Client) => Promise<T>): Promise<T> {
		const { client, release } = await this.acquire(hostId);
		try {
			return await run(client);
		} catch (error) {
			// A connection that died under us is not one to hand out again.
			if (/not connected|no response|ECONNRESET|socket/i.test(String(error))) this.dropPool(hostId);
			throw error;
		} finally {
			release();
		}
	}

	private async withSftp<T>(hostId: string, run: (sftp: SFTPWrapper, resolve: (path: string) => Promise<string>) => Promise<T>): Promise<T> {
		const { remoteDir } = this.environmentCredentials(hostId);
		return this.withClient(hostId, async (client) => {
			const sftp = await sftpCall<SFTPWrapper>((done) => client.sftp(done));
			try {
				let home: string | null = null;
				const resolve = async (path: string) => {
					const target = path.trim() || ".";
					if (target.startsWith("/")) return posix.normalize(target);
					home ??= await sftpCall<string>((done) => sftp.realpath(".", done));
					const tilde = (value: string) =>
						value === "~" ? home! : value.startsWith("~/") ? posix.join(home!, value.slice(2)) : value;
					if (target === "~" || target.startsWith("~/")) return posix.normalize(tilde(target));
					const base = remoteDir ? tilde(remoteDir) : home;
					return posix.normalize(posix.isAbsolute(base) ? posix.join(base, target) : posix.join(home, base, target));
				};
				return await run(sftp, resolve);
			} finally {
				sftp.end();
			}
		});
	}

	/** Provision sandbox hosts first; then probe management SSH and pin its host key. */
	async test(hostId: string): Promise<SshTestResult> {
		if (this.store.credentials(hostId).desktopMode === "sandbox") await this.prepareSandbox(hostId);
		else this.disconnect(hostId);
		const client = await this.openHost(this.store.credentials(hostId));
		try {
			const result = await this.run(client, "uname -srm 2>/dev/null || ver", null, 15_000);
			const fingerprint = this.store.hosts().find((host) => host.id === hostId)?.fingerprint ?? "";
			return { fingerprint, system: result.stdout.trim().split("\n")[0]?.trim() || null };
		} finally {
			client.end();
		}
	}

	private run(client: Client, command: string, cwd: string | null, timeoutMs: number, signal?: AbortSignal): Promise<SshExecResult> {
		const line = cwd ? `cd ${shellQuotePath(cwd)} && ${command}` : command;
		return new Promise((resolve, reject) => {
			client.exec(line, (error, stream) => {
				if (error) return reject(error);
				const stdout = new TailBuffer();
				const stderr = new TailBuffer();
				let timedOut = false;
				let settled = false;
				const stop = () => {
					try {
						stream.signal("KILL");
					} catch {}
					stream.close();
				};
				const timer = setTimeout(() => {
					timedOut = true;
					stop();
					finish(null);
				}, timeoutMs);
				const onAbort = () => { stop(); finish(null); };
				signal?.addEventListener("abort", onAbort, { once: true });
				stream.on("data", (chunk: Buffer) => stdout.push(chunk));
				stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
				const finish = (code: number | null, exitSignal?: string) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) return reject(new Error("SSH command cancelled"));
					resolve({
						code: typeof code === "number" ? code : null,
						signal: exitSignal ?? null,
						stdout: stdout.text(),
						stderr: stderr.text(),
						timedOut,
						truncated: stdout.dropped + stderr.dropped,
					});
				};
				stream.on("close", finish);
				if (signal?.aborted) onAbort();
			});
		});
	}

	async exec(
		hostId: string,
		command: string,
		options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<SshExecResult> {
		const { remoteDir } = this.environmentCredentials(hostId);
		const timeout = Math.min(Math.max(options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, 1000), MAX_EXEC_TIMEOUT_MS);
		return this.withClient(hostId, (client) => this.run(client, command, remoteCwd(remoteDir, options.cwd), timeout, options.signal));
	}

	async list(hostId: string, path: string): Promise<{ path: string; entries: SshEntry[] }> {
		return this.withSftp(hostId, async (sftp, resolve) => {
			const target = await resolve(path);
			const raw = await sftpCall<Array<{ filename: string; attrs: { size: number; mtime: number; mode: number } }>>((done) =>
				sftp.readdir(target, done),
			);
			const entries = raw
				.map(({ filename, attrs }) => ({
					name: filename,
					type: kindOf(attrs.mode),
					size: attrs.size,
					modified: attrs.mtime * 1000,
				}))
				.sort((a, b) => (a.type === "directory") === (b.type === "directory") ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
			return { path: target, entries };
		});
	}

	/** Copy a local file or directory to the server. Directories skip `.git` and `node_modules`. */
	async upload(hostId: string, localPath: string, remotePath: string, signal?: AbortSignal): Promise<SshTransferResult> {
		const source = statSync(localPath);
		return this.withSftp(hostId, async (sftp, resolve) => {
			const target = await resolve(remotePath);
			const result: SshTransferResult = { files: 0, bytes: 0, target, skipped: [] };
			const mkdirs = async (dir: string) => {
				const parts = dir.split("/").filter(Boolean);
				let current = dir.startsWith("/") ? "/" : "";
				for (const part of parts) {
					current = posix.join(current, part);
					const exists = await sftpCall((done) => sftp.stat(current, done)).then(() => true, () => false);
					if (!exists) await sftpCall((done) => sftp.mkdir(current, done));
				}
			};
			const put = async (from: string, to: string, size: number) => {
				if (signal?.aborted) throw new Error("SSH upload cancelled");
				if (++result.files > MAX_TRANSFER_FILES) throw new Error(`Upload stopped at ${MAX_TRANSFER_FILES} files; upload a narrower directory or an archive`);
				await sftpCall((done) => sftp.fastPut(from, to, done));
				result.bytes += size;
			};
			if (!source.isDirectory()) {
				await mkdirs(posix.dirname(target));
				await put(localPath, target, source.size);
				return result;
			}
			const walk = async (from: string, to: string): Promise<void> => {
				await mkdirs(to);
				for (const entry of await readdir(from, { withFileTypes: true })) {
					const child = join(from, entry.name);
					if (entry.isDirectory()) {
						if (SKIPPED_UPLOAD_DIRS.has(entry.name)) result.skipped.push(child);
						else await walk(child, posix.join(to, entry.name));
					} else if (entry.isFile()) await put(child, posix.join(to, entry.name), statSync(child).size);
				}
			};
			await walk(localPath, target);
			return result;
		});
	}

	/** Copy a remote file or directory to this machine. */
	async download(hostId: string, remotePath: string, localPath: string, signal?: AbortSignal): Promise<SshTransferResult> {
		return this.withSftp(hostId, async (sftp, resolve) => {
			const source = await resolve(remotePath);
			const result: SshTransferResult = { files: 0, bytes: 0, target: localPath, skipped: [] };
			const get = async (from: string, to: string, size: number) => {
				if (signal?.aborted) throw new Error("SSH download cancelled");
				if (++result.files > MAX_TRANSFER_FILES) throw new Error(`Download stopped at ${MAX_TRANSFER_FILES} files`);
				mkdirSync(dirname(to), { recursive: true });
				await sftpCall((done) => sftp.fastGet(from, to, done));
				result.bytes += size;
			};
			const walk = async (from: string, to: string): Promise<void> => {
				mkdirSync(to, { recursive: true });
				const entries = await sftpCall<Array<{ filename: string; attrs: { size: number; mode: number } }>>((done) => sftp.readdir(from, done));
				for (const { filename, attrs } of entries) {
					const kind = kindOf(attrs.mode);
					if (kind === "directory") await walk(posix.join(from, filename), join(to, filename));
					else if (kind === "file") await get(posix.join(from, filename), join(to, filename), attrs.size);
				}
			};
			const attrs = await sftpCall<{ size: number; mode: number }>((done) => sftp.stat(source, done));
			if (kindOf(attrs.mode) === "directory") await walk(source, localPath);
			else await get(source, localPath, attrs.size);
			return result;
		});
	}

	/**
	 * A connection of its own for something long-lived — a remote desktop
	 * tunnel — that must not hold the pool open or be closed by its idle timer.
	 * The caller ends it.
	 */
	async dedicated(hostId: string): Promise<{ client: Client; credentials: SshCredentials }> {
		const credentials = this.environmentCredentials(hostId);
		return { client: await this.open(credentials), credentials };
	}

	async manageSandbox(hostId: string, action: "stop" | "reset"): Promise<void> {
		const credentials = this.store.credentials(hostId);
		if (credentials.desktopMode !== "sandbox") throw new Error("This server is not configured for a sandbox");
		this.disconnect(hostId);
		await this.sandbox.manage(hostId, action, () => this.openHost(credentials));
	}

	/**
	 * An interactive login shell for the terminal panel, on a connection of its
	 * own: closing the shell closes it, and it never holds the pool open.
	 */
	async shell(hostId: string, size: { cols: number; rows: number }): Promise<{ channel: ClientChannel; close: () => void }> {
		const credentials = this.environmentCredentials(hostId);
		const client = await this.open(credentials);
		try {
			const channel = await new Promise<ClientChannel>((resolve, reject) => {
				let expired = false;
				const timer = setTimeout(() => {
					expired = true;
					client.end();
					reject(new Error("Remote terminal did not start within 20 seconds"));
				}, READY_TIMEOUT_MS);
				client.shell({ term: "xterm-256color", cols: size.cols, rows: size.rows }, (error, stream) => {
					clearTimeout(timer);
					if (expired) { stream?.close(); return; }
					error ? reject(error) : resolve(stream);
				});
			});
			if (credentials.remoteDir) channel.write(`cd ${shellQuotePath(credentials.remoteDir)}\n`);
			channel.on("close", () => client.end());
			return { channel, close: () => client.end() };
		} catch (error) {
			client.end();
			throw error;
		}
	}
}

function kindOf(mode: number): SshEntry["type"] {
	const type = mode & 0o170000;
	return type === 0o040000 ? "directory" : type === 0o100000 ? "file" : type === 0o120000 ? "symlink" : "other";
}
