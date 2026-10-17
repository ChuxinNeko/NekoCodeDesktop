import { createHash } from "node:crypto";
import { Client, utils } from "ssh2";
import type { SshCredentials } from "./ssh-store";
import { shellQuote } from "./posix-shell";
import type { SandboxDeployment } from "../shared/ssh";
import { deploySandbox } from "./sandbox-deployment";

export const SANDBOX_CONTROL = "/usr/local/libexec/nekocode-sandbox/control.py";
export function sandboxName(hostId: string): string {
	return `nekocode-${createHash("sha256").update(hostId).digest("hex").slice(0, 24)}`;
}

function control(client: Client, args: string[], input = ""): Promise<string> {
	return new Promise((resolve, reject) => {
		client.exec(`python3 ${shellQuote(SANDBOX_CONTROL)} ${args.map(shellQuote).join(" ")}`, (error, stream) => {
			if (error) return reject(error);
			let output = "", stderr = "";
			const timer = setTimeout(() => { stream.close(); reject(new Error("Sandbox startup timed out")); }, 120_000);
			stream.on("data", (data: Buffer) => { output = (output + data.toString()).slice(-65536); });
			stream.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
			stream.on("error", reject);
			stream.on("close", (code: number) => {
				clearTimeout(timer);
				if (code !== 0) reject(new Error(`Desktop sandbox unavailable: ${stderr.trim() || output.trim()}. Retry the connection or check server sandbox setup; no host fallback was used.`));
				else resolve(output);
			});
			stream.end(input);
		});
	});
}

export function parseSandboxEndpoint(output: string): { port: number; hostKey: string; containerId: string } {
	const value = JSON.parse(output);
	if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
		typeof value.hostKey !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.hostKey) ||
		typeof value.containerId !== "string" || !/^[a-f0-9]{64}$/.test(value.containerId))
		throw new Error("Invalid sandbox endpoint");
	return value;
}

/** Only this trusted control path uses the host connection. User operations receive the inner SSH client. */
export class DesktopSandbox {
	constructor(private readonly report: (state: SandboxDeployment) => void = () => {}) {}
	private key = utils.generateKeyPairSync("ed25519");
	private queues = new Map<string, Promise<unknown>>();
	private clients = new Map<string, Set<Client>>();
	private generations = new Map<string, number>();

	async prepare(id: string, openHost: () => Promise<Client>): Promise<void> {
		const generation = this.generations.get(id) ?? 0;
		await this.serial(id, async () => {
			if (generation !== (this.generations.get(id) ?? 0)) throw new Error("Sandbox connection cancelled");
			const outer = await openHost();
			try {
				if (generation !== (this.generations.get(id) ?? 0)) throw new Error("Sandbox connection cancelled");
				await deploySandbox(outer, id, state => {
					if (generation === (this.generations.get(id) ?? 0)) this.report(state);
				});
				if (generation !== (this.generations.get(id) ?? 0)) throw new Error("Sandbox connection cancelled");
			}
			finally { outer.end(); }
		});
	}

	private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(id) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(action);
		this.queues.set(id, next);
		try { return await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
	}

	async connect(credentials: SshCredentials, outer: Client): Promise<Client> {
		const id = credentials.id;
		const generation = this.generations.get(id) ?? 0;
		try {
			return await this.serial(id, async () => {
				if (generation !== (this.generations.get(id) ?? 0)) throw new Error("Sandbox connection cancelled");
				await deploySandbox(outer, id, state => {
					if (generation === (this.generations.get(id) ?? 0)) this.report(state);
				});
				if (generation !== (this.generations.get(id) ?? 0)) throw new Error("Sandbox connection cancelled");
				const endpoint = parseSandboxEndpoint(await control(outer, ["ensure", sandboxName(id)], this.key.public));
				const sock = await new Promise<import("ssh2").ClientChannel>((resolve, reject) =>
					outer.forwardOut("127.0.0.1", 0, "127.0.0.1", endpoint.port, (error, channel) => error ? reject(error) : resolve(channel)));
				const inner = new Client();
				inner.on("error", () => {});
				outer.on("close", () => inner.destroy());
				inner.on("close", () => { outer.end(); this.clients.get(id)?.delete(inner); });
				await new Promise<void>((resolve, reject) => {
					inner.once("ready", resolve);
					inner.once("error", reject);
					inner.connect({ sock, username: "neko", privateKey: this.key.private, readyTimeout: 20_000,
						keepaliveInterval: 15_000, keepaliveCountMax: 4,
						hostVerifier: (key: Buffer) => key.equals(Buffer.from(endpoint.hostKey, "base64")) });
				});
				if (generation !== (this.generations.get(id) ?? 0)) { inner.destroy(); throw new Error("Sandbox connection cancelled"); }
				let clients = this.clients.get(id);
				if (!clients) this.clients.set(id, clients = new Set());
				clients.add(inner);
				return inner;
			});
		} catch (error) { outer.end(); throw error; }
	}

	disconnect(id: string): void {
		this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
		for (const client of this.clients.get(id) ?? []) client.destroy();
		this.clients.delete(id);
	}

	async manage(id: string, action: "stop" | "reset", openHost: () => Promise<Client>): Promise<void> {
		this.disconnect(id);
		await this.serial(id, async () => {
			const outer = await openHost();
			try { await control(outer, [action, sandboxName(id)]); }
			finally { outer.end(); }
		});
	}
}
