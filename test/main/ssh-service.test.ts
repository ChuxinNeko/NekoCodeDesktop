import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { PassThrough } from "node:stream";
import { Server, utils, type Connection } from "ssh2";
import { describeSshError, hostKeyFingerprint, remoteCwd, shellQuotePath, SshService } from "../../src/main/ssh-service";
import { SshStore } from "../../src/main/ssh-store";
import { configureSshTool, createSshTool } from "../../src/main/ssh-tool";

const { STATUS_CODE, flagsToString } = utils.sftp;
const USER = "neko";
const PASSWORD = "p@ss 'word";

test("command timeout returns even when the peer never acknowledges channel close", async () => {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let terminationRequested = false;
	const channel = Object.assign(stdout, { stderr, signal: () => { terminationRequested = true; }, close: () => {} });
	const client = { exec: (_command: string, ready: (error: null, stream: unknown) => void) => {
		ready(null, channel); stdout.write("output before timeout");
	} };
	const service = new SshService({} as SshStore);
	const runner = service as unknown as { run(client: unknown, command: string, cwd: null, timeoutMs: number): Promise<{ timedOut: boolean; stdout: string }> };
	const result = await runner.run(client, "unresponsive remote", null, 20);
	expect(result.timedOut).toBe(true); expect(result.stdout).toBe("output before timeout"); expect(terminationRequested).toBe(true);
	stdout.destroy(); stderr.destroy();
}, 2000);

const dirs: string[] = [];
function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function fakeEncryption() {
	return {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => "kwallet6" as const,
		encryptString: (value: string) => Buffer.from(value, "utf8").reverse(),
		decryptString: (value: Buffer) => Buffer.from(value).reverse().toString("utf8"),
	};
}

/**
 * A real SSH server in-process: password auth, an exec that echoes what it
 * was asked to run, a line-echo shell, and SFTP over a temporary directory
 * standing in for the remote filesystem (remote "/" is that directory, the
 * login home is /home/neko).
 */
function startServer(root: string, hostKey: string) {
	const commands: string[] = [];
	const local = (path: string) => join(root, ...posix.normalize(path).split("/").filter(Boolean));
	const attrs = (path: string) => {
		const stat = statSync(local(path));
		return { mode: stat.mode, uid: 0, gid: 0, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) };
	};
	const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
		client.on("authentication", (ctx) => {
			if (ctx.method === "password" && ctx.username === USER && ctx.password === PASSWORD) ctx.accept();
			else ctx.reject(["password"]);
		});
		client.on("error", () => {});
		client.on("ready", () => {
			client.on("session", (accept) => {
				const session = accept();
				session.on("exec", (acceptExec, _reject, info) => {
					const stream = acceptExec();
					commands.push(info.command);
					if (info.command.endsWith("hang")) return; // until the client gives up
					if (info.command.includes("uname")) stream.write("Linux 6.8.0 x86_64\n");
					else stream.write(`ran: ${info.command}\n`);
					stream.stderr.write("a warning\n");
					stream.exit(info.command.includes("fail") ? 3 : 0);
					stream.end();
				});
				session.on("pty", (acceptPty) => acceptPty?.());
				session.on("window-change", (acceptChange) => acceptChange?.());
				session.on("shell", (acceptShell) => {
					const stream = acceptShell();
					stream.write("welcome\r\n");
					stream.on("data", (data: Buffer) => stream.write(`echo:${data.toString()}`));
				});
				session.on("sftp", (acceptSftp) => {
					const sftp = acceptSftp();
					const handles = new Map<number, { fd?: number; dir?: string; listed?: boolean }>();
					let next = 0;
					const handle = (value: { fd?: number; dir?: string }) => {
						const buffer = Buffer.alloc(4);
						buffer.writeUInt32BE(++next);
						handles.set(next, value);
						return buffer;
					};
					const lookup = (buffer: Buffer) => handles.get(buffer.readUInt32BE(0));
					const guard = (reqid: number, run: () => void) => {
						try {
							run();
						} catch {
							sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
						}
					};
					sftp.on("REALPATH", (reqid, path) => {
						const resolved = posix.resolve("/home/neko", path);
						sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} as never }]);
					});
					sftp.on("STAT", (reqid, path) => guard(reqid, () => sftp.attrs(reqid, attrs(path))));
					sftp.on("LSTAT", (reqid, path) => guard(reqid, () => sftp.attrs(reqid, attrs(path))));
					sftp.on("MKDIR", (reqid, path) => guard(reqid, () => {
						mkdirSync(local(path));
						sftp.status(reqid, STATUS_CODE.OK);
					}));
					sftp.on("OPEN", (reqid, filename, flags) => guard(reqid, () => {
						sftp.handle(reqid, handle({ fd: openSync(local(filename), flagsToString(flags) ?? "r") }));
					}));
					sftp.on("FSTAT", (reqid, buffer) => guard(reqid, () => {
						const stat = fstatSync(lookup(buffer)!.fd!);
						sftp.attrs(reqid, { mode: stat.mode, uid: 0, gid: 0, size: stat.size, atime: 0, mtime: 0 });
					}));
					sftp.on("WRITE", (reqid, buffer, offset, data) => {
						writeSync(lookup(buffer)!.fd!, data, 0, data.length, offset);
						sftp.status(reqid, STATUS_CODE.OK);
					});
					sftp.on("READ", (reqid, buffer, offset, length) => {
						const chunk = Buffer.alloc(length);
						const read = readSync(lookup(buffer)!.fd!, chunk, 0, length, offset);
						if (read === 0) sftp.status(reqid, STATUS_CODE.EOF);
						else sftp.data(reqid, chunk.subarray(0, read));
					});
					sftp.on("OPENDIR", (reqid, path) => guard(reqid, () => {
						statSync(local(path));
						sftp.handle(reqid, handle({ dir: path }));
					}));
					sftp.on("READDIR", (reqid, buffer) => {
						const entry = lookup(buffer)!;
						if (entry.listed) return sftp.status(reqid, STATUS_CODE.EOF);
						entry.listed = true;
						sftp.name(reqid, readdirSync(local(entry.dir!)).map((name) => ({
							filename: name,
							longname: name,
							attrs: attrs(posix.join(entry.dir!, name)),
						})));
					});
					sftp.on("SETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
					sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
					sftp.on("CLOSE", (reqid, buffer) => {
						const entry = lookup(buffer);
						if (entry?.fd !== undefined) closeSync(entry.fd);
						handles.delete(buffer.readUInt32BE(0));
						sftp.status(reqid, STATUS_CODE.OK);
					});
				});
			});
		});
	});
	return { server, commands };
}

let root: string;
let port: number;
let server: Server;
let commands: string[];
let store: SshStore;
let service: SshService;
let hostId: string;

beforeAll(async () => {
	root = tmp("nekocode-ssh-remote-");
	mkdirSync(join(root, "home", "neko"), { recursive: true });
	writeFileSync(join(root, "home", "neko", "hello.txt"), "hi from the server\n");
	const key = utils.generateKeyPairSync("ed25519");
	({ server, commands } = startServer(root, key.private));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	store = new SshStore(tmp("nekocode-ssh-store-"), fakeEncryption());
	service = new SshService(store);
	store.save({ name: "prod", host: "127.0.0.1", port, username: USER, auth: "password", secret: PASSWORD, remoteDir: "/srv/app" });
	hostId = store.hosts()[0].id;
});

afterAll(() => {
	service.disconnectAll();
	server.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SshService against a live server", () => {
	test("connects with a password and pins the host key on first use", async () => {
		expect(store.hosts()[0].fingerprint).toBeNull();
		const result = await service.test(hostId);
		expect(result.system).toBe("Linux 6.8.0 x86_64");
		expect(result.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
		expect(store.hosts()[0].fingerprint).toBe(result.fingerprint);
	});

	test("runs a command in the host's directory and reports its exit code", async () => {
		const ok = await service.exec(hostId, "ls -la");
		expect(ok.code).toBe(0);
		expect(ok.stdout).toBe("ran: cd '/srv/app' && ls -la\n");
		expect(ok.stderr).toBe("a warning\n");
		const failed = await service.exec(hostId, "fail now", { cwd: "releases" });
		expect(failed.code).toBe(3);
		expect(commands.at(-1)).toBe("cd '/srv/app/releases' && fail now");
	});

	test("kills a command that runs past its timeout", async () => {
		const result = await service.exec(hostId, "hang", { timeoutMs: 1000 });
		expect(result.timedOut).toBe(true);
	});

	test("uploads a directory over SFTP, skipping .git and node_modules", async () => {
		const local = tmp("nekocode-ssh-local-");
		mkdirSync(join(local, "dist", "assets"), { recursive: true });
		mkdirSync(join(local, "dist", "node_modules", "x"), { recursive: true });
		mkdirSync(join(local, "dist", ".git"), { recursive: true });
		writeFileSync(join(local, "dist", "index.html"), "<h1>hi</h1>");
		writeFileSync(join(local, "dist", "assets", "app.js"), "console.log(1)");
		writeFileSync(join(local, "dist", "node_modules", "x", "index.js"), "");
		writeFileSync(join(local, "dist", ".git", "HEAD"), "");
		const result = await service.upload(hostId, join(local, "dist"), "/var/www/site");
		expect(result.files).toBe(2);
		expect(result.target).toBe("/var/www/site");
		expect(result.skipped).toHaveLength(2);
		expect(readFileSync(join(root, "var", "www", "site", "assets", "app.js"), "utf8")).toBe("console.log(1)");
		expect(existsSync(join(root, "var", "www", "site", "node_modules"))).toBe(false);
	});

	test("resolves ~ against the login home, lists, and downloads", async () => {
		const listing = await service.list(hostId, "~");
		expect(listing.path).toBe("/home/neko");
		expect(listing.entries.map((entry) => entry.name)).toEqual(["hello.txt"]);
		const target = join(tmp("nekocode-ssh-download-"), "copy", "hello.txt");
		const result = await service.download(hostId, "~/hello.txt", target);
		expect(result.files).toBe(1);
		expect(readFileSync(target, "utf8")).toBe("hi from the server\n");
	});

	test("opens an interactive shell", async () => {
		const { channel, close } = await service.shell(hostId, { cols: 80, rows: 24 });
		const output: string[] = [];
		channel.on("data", (chunk: Buffer) => output.push(chunk.toString()));
		channel.write("pwd\n");
		await new Promise((resolve) => setTimeout(resolve, 300));
		close();
		const text = output.join("");
		expect(text).toContain("welcome");
		// The saved remote directory is entered first, then what the user typed.
		expect(text).toContain("echo:cd '/srv/app'");
		expect(text).toContain("echo:pwd");
	});

	test("refuses a server whose host key changed", async () => {
		store.setFingerprint(hostId, "SHA256:somethingElse");
		service.disconnect(hostId);
		await expect(service.exec(hostId, "ls")).rejects.toThrow(/host key of 127\.0\.0\.1 changed/);
		store.setFingerprint(hostId, null);
	});

	test("says so when the password is wrong", async () => {
		store.save({ ...store.hosts()[0], secret: "wrong" });
		service.disconnect(hostId);
		await expect(service.exec(hostId, "ls")).rejects.toThrow(/authentication failed/);
		store.save({ ...store.hosts()[0], secret: PASSWORD });
		service.disconnect(hostId);
	});
});

describe("the agent's ssh tool against a live server", () => {
	const call = async (tool: ReturnType<typeof createSshTool>, params: Record<string, unknown>) => {
		const result = await tool.execute("call", params as never, undefined, undefined, undefined as never);
		return (result.content[0] as { text: string }).text;
	};

	test("runs, uploads, lists and downloads by host name, inside the workspace only", async () => {
		configureSshTool(() => ({ store, service }));
		const workspace = tmp("nekocode-ssh-workspace-");
		writeFileSync(join(workspace, "build.txt"), "v2");
		const writes: string[] = [];
		const tool = createSshTool(workspace, { assertWritable: (path) => writes.push(path) });

		expect(await call(tool, { op: "hosts" })).toContain("prod — neko@127.0.0.1");
		const ran = await call(tool, { op: "exec", host: "prod", command: "systemctl restart app" });
		expect(ran).toContain("[prod] exit code 0");
		expect(ran).toContain("ran: cd '/srv/app' && systemctl restart app");
		expect(ran).toContain("--- stderr ---\na warning");

		expect(await call(tool, { op: "upload", local: "build.txt", remote: "/opt/build.txt" })).toContain("Uploaded 1 file(s)");
		expect(readFileSync(join(root, "opt", "build.txt"), "utf8")).toBe("v2");
		expect(await call(tool, { op: "ls", remote: "/opt" })).toContain("build.txt");
		expect(await call(tool, { op: "download", remote: "~/hello.txt", local: "logs/hello.txt" })).toContain("Downloaded 1 file(s)");
		expect(readFileSync(join(workspace, "logs", "hello.txt"), "utf8")).toBe("hi from the server\n");
		expect(writes).toEqual(["logs/hello.txt"]);

		await expect(call(tool, { op: "upload", local: "../outside.txt", remote: "/tmp/x" })).rejects.toThrow(/outside the workspace/);
		await expect(call(tool, { op: "exec", host: "nowhere", command: "ls" })).rejects.toThrow(/No saved SSH host matches/);
	});
});

describe("ssh helpers", () => {
	test("quotes paths for the shell, leaving ~ to expand", () => {
		expect(shellQuotePath("/srv/it's here")).toBe(`'/srv/it'\\''s here'`);
		expect(shellQuotePath("~/app dir")).toBe("~/'app dir'");
		expect(shellQuotePath("~")).toBe("~");
	});

	test("resolves the working directory against the host's", () => {
		expect(remoteCwd("/srv/app", undefined)).toBe("/srv/app");
		expect(remoteCwd("/srv/app", "logs")).toBe("/srv/app/logs");
		expect(remoteCwd("/srv/app", "/tmp")).toBe("/tmp");
		expect(remoteCwd(null, "logs")).toBe("logs");
		expect(remoteCwd(null, undefined)).toBeNull();
	});

	test("formats the host key like OpenSSH", () => {
		expect(hostKeyFingerprint(Buffer.from("key"))).toBe("SHA256:LHDhK3oGRvkiefQnx7OOczTY5Tic/xZ6HcMOc/gmtoM");
	});

	test("explains connection failures", () => {
		const host = { host: "example.com", port: 22, username: "root" };
		expect(describeSshError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), host).message).toMatch(/refused/);
		expect(describeSshError(Object.assign(new Error("x"), { code: "ENOTFOUND" }), host).message).toMatch(/not found/);
	});
});
