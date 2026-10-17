import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tcpConnect, type AddressInfo } from "node:net";
import { Server, utils, type Connection } from "ssh2";
import { parseSandboxEndpoint, sandboxName } from "../../src/main/desktop-sandbox";
import { SshStore } from "../../src/main/ssh-store";
import { SshService } from "../../src/main/ssh-service";
import { accessibilityWrapper } from "../../src/main/remote-desktop/accessibility";

describe("sandbox transport: real nested SSH connections", () => {
	const innerKey = utils.generateKeyPairSync("ed25519");
	const outerKey = utils.generateKeyPairSync("ed25519");
	const connections: Connection[] = [];
	const hostCommands: string[] = [], guestCommands: string[] = [];
	let authorizedKey = "", unavailable = false, wrongHostKey = false;
	let ensureBarrier: Promise<void> | null = null, ensureStarted: (() => void) | null = null;
	let outer: Server, inner: Server, store: SshStore, service: SshService, id: string, dir: string;
	beforeAll(async () => {
		inner = new Server({ hostKeys: [innerKey.private] }, connection => {
			connections.push(connection); connection.on("error", () => {});
			connection.on("authentication", ctx => {
				if (ctx.method === "publickey" && ctx.username === "neko" && ctx.key.data.equals(Buffer.from(authorizedKey.split(" ")[1], "base64"))) ctx.accept();
				else ctx.reject();
			});
			connection.on("session", accept => {
				const session = accept();
				session.on("exec", (acceptExec, _reject, info) => {
					guestCommands.push(info.command);
					const stream = acceptExec(); stream.end(`sandbox: ${info.command}`); stream.exit(0);
				});
				session.on("pty", accept => accept?.());
				session.on("shell", accept => {
					const stream = accept(); stream.on("data", (data: Buffer) => stream.write(`sandbox-terminal:${data}`));
				});
				session.on("sftp", accept => {
					const sftp = accept(); let listed = false;
					sftp.on("REALPATH", req => sftp.name(req, [{ filename: "/home/neko", longname: "", attrs: {} as never }]));
					sftp.on("OPENDIR", (req, path) => { guestCommands.push(`sftp:${path}`); listed = false; sftp.handle(req, Buffer.from("dir")); });
					sftp.on("READDIR", req => {
						if (listed) sftp.status(req, utils.sftp.STATUS_CODE.EOF);
						else { listed = true; sftp.name(req, [{ filename: "inside-sandbox.txt", longname: "", attrs: { mode: 0o100644, size: 7, mtime: 1, atime: 1, uid: 1000, gid: 1000 } }]); }
					});
					sftp.on("CLOSE", req => sftp.status(req, utils.sftp.STATUS_CODE.OK));
				});
			});
		});
		await new Promise<void>(resolve => inner.listen(0, "127.0.0.1", resolve));
		const innerPort = (inner.address() as AddressInfo).port;
		outer = new Server({ hostKeys: [outerKey.private] }, connection => {
			connections.push(connection); connection.on("error", () => {});
			connection.on("authentication", ctx => ctx.method === "password" && ctx.password === "host-secret" ? ctx.accept() : ctx.reject());
			connection.on("tcpip", (accept, _reject, info) => {
				expect(info.destIP).toBe("127.0.0.1"); expect(info.destPort).toBe(innerPort);
				const stream = accept(); const socket = tcpConnect(innerPort, "127.0.0.1"); socket.pipe(stream).pipe(socket);
				stream.on("close", () => socket.destroy()); socket.on("error", () => stream.destroy());
			});
			connection.on("session", accept => accept().on("exec", (acceptExec, _reject, info) => {
				hostCommands.push(info.command); const stream = acceptExec(); let input = "";
				stream.on("data", (data: Buffer) => input += data);
				stream.on("end", async () => {
					if (unavailable) { stream.stderr.write("runtime missing"); stream.exit(1); stream.end(); return; }
					if (info.command === "sh -s") {
						expect(input).toContain("NEKOCODE_PAYLOAD=");
						expect(input).toContain("flock -w 1800");
						stream.write("NEKOCODE_STAGE:runtime\nNEKOCODE_STAGE:image\n");
					}
					if (info.command.includes("'ensure'")) {
						ensureStarted?.();
						await ensureBarrier;
						authorizedKey = input.trim();
						stream.write(JSON.stringify({ port: innerPort, hostKey: (wrongHostKey ? outerKey : innerKey).public.split(" ")[1], containerId: "a".repeat(64) }));
					}
					stream.exit(0); stream.end();
				});
			}));
		});
		await new Promise<void>(resolve => outer.listen(0, "127.0.0.1", resolve));
		dir = mkdtempSync(join(tmpdir(), "neko-nested-ssh-"));
		store = new SshStore(dir, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "kwallet6", encryptString: x => Buffer.from(x), decryptString: x => x.toString() });
		id = store.save({ host: "127.0.0.1", port: (outer.address() as AddressInfo).port, name: "sandbox", username: "root", auth: "password", secret: "host-secret", desktopMode: "sandbox", remoteDir: "/host-only" }).hosts[0].id;
		service = new SshService(store);
	});
	afterAll(() => {
		service.disconnectAll(); for (const connection of connections) connection.end(); outer.close(); inner.close(); rmSync(dir, { recursive: true, force: true });
	});
	test("commands and SFTP use the guest, not the host directory", async () => {
		const result = await service.exec(id, "echo isolated");
		expect(result.stdout).toContain("cd '/home/neko/workspace' && echo isolated");
		expect(result.stdout).not.toContain("/host-only");
		const listing = await service.list(id, ".");
		expect(listing.path).toBe("/home/neko/workspace");
		expect(listing.entries[0].name).toBe("inside-sandbox.txt");
		expect(hostCommands.every(command => command === "sh -s" || command.startsWith("python3 '/usr/local/libexec/nekocode-sandbox/control.py'"))).toBe(true);
		expect(guestCommands).toContain("sftp:/home/neko/workspace");
	});
	test("dedicated desktops use guest VNC port and interactive terminals use the same guest", async () => {
		const desktop = await service.dedicated(id);
		expect(desktop.credentials.vncPort).toBe(5900);
		expect(desktop.credentials.remoteDir).toBe("/home/neko/workspace");
		desktop.client.end();
		const shell = await service.shell(id, { cols: 80, rows: 24 });
		const echoed = new Promise<string>(resolve => shell.channel.once("data", (data: Buffer) => resolve(data.toString())));
		shell.channel.write("inside\n");
		expect(await echoed).toContain("sandbox-terminal:"); shell.close();
	});
	test("missing runtime fails closed without executing the requested command on the host", async () => {
		service.disconnect(id); unavailable = true;
		const before = hostCommands.length;
		await expect(service.exec(id, "DO_NOT_RUN_ON_HOST")).rejects.toThrow("runtime missing");
		expect(hostCommands.slice(before)).toEqual(["sh -s"]);
		expect(service.sandboxDeployments().find(state => state.hostId === id)?.phase).toBe("error");
		expect(hostCommands.some(c => c.includes("DO_NOT_RUN_ON_HOST"))).toBe(false);
		unavailable = false;
	});
	test("settings preparation deploys without creating a guest session", async () => {
		const before = hostCommands.length, guestBefore = guestCommands.length;
		await service.prepareSandbox(id);
		expect(hostCommands.slice(before)).toEqual(["sh -s"]);
		expect(guestCommands.length).toBe(guestBefore);
		expect(service.sandboxDeployments().find(state => state.hostId === id)?.phase).toBe("ready");
	});
	test("rejects an inner host key which differs from the trusted host's report", async () => {
		service.disconnect(id); wrongHostKey = true;
		await expect(service.exec(id, "must-not-run")).rejects.toThrow();
		wrongHostKey = false;
	});
	test("reset closes existing guest clients before the next connection", async () => {
		service.disconnect(id);
		await service.exec(id, "before-reset");
		await service.manageSandbox(id, "reset");
		await service.exec(id, "after-reset");
		expect(hostCommands.some(c => c.includes("'reset'"))).toBe(true);
		expect(guestCommands.some(c => c.endsWith("after-reset"))).toBe(true);
	});
	test("reset cancels a connection still waiting for sandbox startup", async () => {
		service.disconnect(id);
		let release!: () => void;
		ensureBarrier = new Promise<void>(resolve => { release = resolve; });
		const started = new Promise<void>(resolve => { ensureStarted = resolve; });
		const pending = service.exec(id, "pre-reset-work").then(() => "unexpected success", error => String(error));
		await started;
		const reset = service.manageSandbox(id, "reset");
		release(); ensureBarrier = null; ensureStarted = null;
		expect(await pending).toContain("cancelled"); await reset;
		expect(guestCommands.some(command => command.includes("pre-reset-work"))).toBe(false);
	});
});

test("sandbox names cannot inject shell arguments and endpoint parsing rejects unsafe ports", () => {
	expect(sandboxName("a'; rm -rf /")).toMatch(/^nekocode-[a-f0-9]{24}$/);
	expect(() => parseSandboxEndpoint(JSON.stringify({ port: -1, hostKey: "a", containerId: "a".repeat(64) }))).toThrow();
	expect(accessibilityWrapper(":1").split("\n")[0]).toBe("d=1");
});
