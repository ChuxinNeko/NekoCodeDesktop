import { createServer, createConnection, type Server } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export interface ProfileEncryption {
	isEncryptionAvailable(): boolean;
	getSelectedStorageBackend(): string;
	encryptString(value: string): Buffer;
	decryptString(value: Buffer): string;
}
export type ProfileStorage = Record<string, string>;
export interface ProfileHandoff { storage: ProfileStorage }

/** A private Unix socket keeps credentials in the original user's keyring and off disk/argv. */
export class LinuxProfileBridge {
	readonly token = randomBytes(32).toString("hex");
	private server?: Server;
	private directory?: string;
	private socketPath?: string;
	private preparation?: Promise<ProfileHandoff>;
	prepared = false;
	constructor(private readonly options: {
		encryption: ProfileEncryption;
		prepare(): Promise<ProfileHandoff>;
		saveStorage(storage: ProfileStorage): Promise<void>;
	}) {}

	async start(): Promise<string> {
		if (this.socketPath) return this.socketPath;
		this.directory = mkdtempSync(join(tmpdir(), "neko-profile-"));
		chmodSync(this.directory, 0o700);
		const path = process.platform === "win32" ? `\\\\.\\pipe\\neko-profile-${this.token}` : join(this.directory, "bridge.sock");
		this.server = createServer((socket) => {
			let input = "";
			let answered = false;
			socket.setTimeout(60_000, () => socket.destroy());
			socket.setEncoding("utf8");
			socket.on("error", () => {});
			socket.on("data", (chunk: string) => {
				if (answered) return;
				input += chunk;
				if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) { socket.destroy(); return; }
				if (!input.includes("\n")) return;
				answered = true;
				void (async () => {
					try {
						const request = JSON.parse(input.slice(0, input.indexOf("\n")));
						if (request.token !== this.token) throw new Error("Invalid profile bridge token");
						const value = await this.dispatch(request.operation, request.value);
						socket.end(JSON.stringify({ ok: true, value }) + "\n");
					} catch {
						// Encryption errors must never echo plaintext or token values.
						socket.end(JSON.stringify({ ok: false, error: "Profile handoff or keyring operation failed" }) + "\n");
					}
				})();
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(path, () => { if (process.platform !== "win32") chmodSync(path, 0o600); resolve(); });
		});
		this.socketPath = path;
		return path;
	}

	private async dispatch(operation: string, value: unknown): Promise<unknown> {
		const encryption = this.options.encryption;
		switch (operation) {
			case "status": return { available: encryption.isEncryptionAvailable(), backend: encryption.getSelectedStorageBackend() };
			case "encrypt":
				if (typeof value !== "string") throw new Error("Invalid plaintext");
				return encryption.encryptString(value).toString("base64");
			case "decrypt":
				if (typeof value !== "string") throw new Error("Invalid ciphertext");
				return encryption.decryptString(Buffer.from(value, "base64"));
			case "prepare":
				this.preparation ??= this.options.prepare().then((handoff) => { this.prepared = true; return handoff; })
					.catch((error) => { this.preparation = undefined; throw error; });
				return this.preparation;
			case "storage":
				if (!this.prepared || !isProfileStorage(value)) throw new Error("Invalid storage snapshot");
				await this.options.saveStorage(value);
				return null;
			default: throw new Error("Unsupported profile operation");
		}
	}

	close(): void {
		this.server?.close();
		if (this.directory) rmSync(this.directory, { recursive: true, force: true });
		this.directory = undefined;
		this.socketPath = undefined;
	}
}

export function isProfileStorage(value: unknown): value is ProfileStorage {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& Object.entries(value).every(([key, item]) => key.length < 4096 && typeof item === "string");
}

/** Used by tests and asynchronous callers; the root facade uses a short-lived helper for Electron's sync API. */
export function profileRequest(path: string, token: string, operation: string, value?: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		socket.setEncoding("utf8");
		let output = "";
		socket.setTimeout(60_000, () => socket.destroy(new Error("Profile request timed out")));
		socket.on("error", reject);
		socket.on("connect", () => socket.write(JSON.stringify({ token, operation, value }) + "\n"));
		socket.on("data", (data: string) => { output += data; if (output.length > MAX_MESSAGE_BYTES) socket.destroy(new Error("Profile response too large")); });
		socket.on("end", () => {
			try { const result = JSON.parse(output); if (result.ok) resolve(result.value); else reject(new Error(result.error)); }
			catch (error) { reject(error); }
		});
	});
}

// Only built-in Node APIs run in this helper. Request secrets travel through inherited pipes.
const CLIENT = `const net=require('node:net');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const req=JSON.parse(input);const s=net.createConnection(req.path);s.setEncoding('utf8');let output='';s.setTimeout(55000,()=>{s.destroy();process.exit(1)});s.on('error',()=>process.exit(1));s.on('connect',()=>s.write(JSON.stringify(req)+'\\n'));s.on('data',d=>{output+=d;if(output.length>16777216)process.exit(1)});s.on('end',()=>process.stdout.write(output));});`;

export function profileRequestSync(path: string, token: string, operation: string, value?: unknown): unknown {
	const result = spawnSync(process.execPath, ["-e", CLIENT], {
		env: { ELECTRON_RUN_AS_NODE: "1" },
		input: JSON.stringify({ path, token, operation, value }), encoding: "utf8", timeout: 60_000,
		maxBuffer: MAX_MESSAGE_BYTES, windowsHide: true,
	});
	if (result.error || result.status !== 0) throw new Error("Original user profile bridge is unavailable");
	const response = JSON.parse(result.stdout);
	if (!response.ok) throw new Error("Original user profile operation failed");
	return response.value;
}
