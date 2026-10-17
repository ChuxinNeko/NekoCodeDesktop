import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshStore } from "../../src/main/ssh-store";
import { pickHost } from "../../src/main/ssh-tool";
import { toolsForMode } from "../../src/main/prompt-library";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-ssh-"));
	dirs.push(dir);
	return dir;
}

function fakeEncryption(available = true) {
	return {
		isEncryptionAvailable: () => available,
		getSelectedStorageBackend: () => "kwallet6" as const,
		encryptString: (value: string) => Buffer.from(value, "utf8").reverse(),
		decryptString: (value: Buffer) => Buffer.from(value).reverse().toString("utf8"),
	};
}

const base = { name: "prod", host: "10.0.0.5", port: 22, username: "deploy", auth: "password" as const, secret: "hunter2" };

describe("SshStore", () => {
	test("keeps legacy hosts in host mode and persists explicit sandbox selection", () => {
		const dir = tmp();
		const store = new SshStore(dir, fakeEncryption());
		const id = store.save(base).hosts[0].id;
		expect(store.credentials(id).desktopMode).toBe("host");
		store.save({ ...base, id, desktopMode: "sandbox", sandboxDir: "/home/neko/project" });
		expect(new SshStore(dir, fakeEncryption()).credentials(id)).toMatchObject({ desktopMode: "sandbox", sandboxDir: "/home/neko/project" });
		store.save({ ...base, id, name: "renamed" });
		expect(store.credentials(id).desktopMode).toBe("sandbox");
		expect(store.credentials(id).sandboxDir).toBe("/home/neko/project");
		expect(() => store.save({ ...base, desktopMode: "container" })).toThrow("environment");
		expect(() => store.save({ ...base, sandboxDir: "../../host" })).toThrow("absolute Linux path");
	});
	test("keeps the password encrypted and out of the renderer's view", () => {
		const dir = tmp();
		const store = new SshStore(dir, fakeEncryption());
		const status = store.save(base);
		expect(status.hosts).toHaveLength(1);
		expect(status.hosts[0]).not.toHaveProperty("secret");
		expect(status.hosts[0].hasSecret).toBe(true);
		expect(readFileSync(join(dir, "ssh-hosts.json"), "utf8")).not.toContain("hunter2");
		expect(new SshStore(dir, fakeEncryption()).credentials(status.hosts[0].id).secret).toBe("hunter2");
	});

	test("keeps the stored password when an edit leaves it out", () => {
		const store = new SshStore(tmp(), fakeEncryption());
		const id = store.save(base).hosts[0].id;
		store.save({ ...base, id, name: "production", secret: undefined });
		expect(store.credentials(id).secret).toBe("hunter2");
		expect(store.hosts()[0].name).toBe("production");
	});

	test("refuses a password it cannot encrypt, and a password host with none", () => {
		expect(() => new SshStore(tmp(), fakeEncryption(false)).save(base)).toThrow(/keyring/);
		expect(() => new SshStore(tmp(), fakeEncryption()).save({ ...base, secret: "" })).toThrow(/password/);
	});

	test("a key host needs only a key path", () => {
		const store = new SshStore(tmp(), fakeEncryption(false));
		const host = store.save({ ...base, auth: "key", secret: undefined, privateKeyPath: "~/.ssh/id_ed25519" }).hosts[0];
		expect(host.privateKeyPath).toBe("~/.ssh/id_ed25519");
		expect(host.hasSecret).toBe(false);
	});

	test("forgets the pinned host key when the address changes", () => {
		const store = new SshStore(tmp(), fakeEncryption());
		const id = store.save(base).hosts[0].id;
		store.setFingerprint(id, "SHA256:abc");
		store.save({ ...base, id, name: "renamed" });
		expect(store.hosts()[0].fingerprint).toBe("SHA256:abc");
		store.save({ ...base, id, host: "10.0.0.6" });
		expect(store.hosts()[0].fingerprint).toBeNull();
	});

	test("validates what arrives over IPC", () => {
		const store = new SshStore(tmp(), fakeEncryption());
		expect(() => store.save({ ...base, host: "root@example.com" })).toThrow(/bare hostname/);
		expect(() => store.save({ ...base, port: 70000 })).toThrow(/port/);
		expect(() => store.save({ ...base, username: " " })).toThrow(/username/);
		expect(() => store.save({ ...base, auth: "key", privateKeyPath: "" })).toThrow(/key file/);
		expect(store.save({ ...base, name: "" }).hosts[0].name).toBe("deploy@10.0.0.5");
	});

	test("keeps a VNC server's port and encrypted password, and drops the password for automatic", () => {
		const dir = tmp();
		const store = new SshStore(dir, fakeEncryption());
		const id = store.save({ ...base, vncPort: 5901, vncPassword: "vncpw" }).hosts[0].id;
		expect(store.hosts()[0]).toMatchObject({ vncPort: 5901, hasVncPassword: true });
		expect(store.credentials(id).vncPassword).toBe("vncpw");
		expect(readFileSync(join(dir, "ssh-hosts.json"), "utf8")).not.toContain("vncpw");
		store.save({ ...base, id, secret: undefined, vncPort: 5902 });
		expect(store.credentials(id).vncPassword).toBe("vncpw");
		store.save({ ...base, id, secret: undefined, vncPort: null });
		expect(store.hosts()[0]).toMatchObject({ vncPort: null, hasVncPassword: false });
		expect(() => store.save({ ...base, vncPort: 0 })).toThrow(/VNC port/);
	});

	test("finds a host by id, name, or user@host", () => {
		const store = new SshStore(tmp(), fakeEncryption());
		const id = store.save(base).hosts[0].id;
		store.save({ ...base, name: "staging", host: "10.0.0.9" });
		expect(store.find(id)?.name).toBe("prod");
		expect(store.find("PROD")?.id).toBe(id);
		expect(store.find("deploy@10.0.0.9")?.name).toBe("staging");
		expect(store.find("nope")).toBeNull();
	});
});

describe("ssh tool", () => {
	test("picks the only host implicitly, and insists on a name among several", () => {
		const store = new SshStore(tmp(), fakeEncryption());
		store.save(base);
		expect(pickHost(store.hosts(), undefined, (ref) => store.find(ref)).name).toBe("prod");
		store.save({ ...base, name: "staging", host: "10.0.0.9" });
		expect(() => pickHost(store.hosts(), undefined, (ref) => store.find(ref))).toThrow(/Several SSH hosts/);
		expect(pickHost(store.hosts(), "staging", (ref) => store.find(ref)).host).toBe("10.0.0.9");
		expect(() => pickHost([], undefined, () => null)).toThrow(/Settings → SSH/);
	});

	test("is offered only where the session may act, a host is saved, and it is not a worker", () => {
		const agent = { mode: "agent" as const, phase: "execute" as const, permission: "auto" as const };
		expect(toolsForMode({ ...agent, sshTools: true })).toContain("ssh");
		expect(toolsForMode(agent)).not.toContain("ssh");
		expect(toolsForMode({ ...agent, sshTools: true, permission: "read-only" })).not.toContain("ssh");
		expect(toolsForMode({ ...agent, phase: "plan", sshTools: true })).not.toContain("ssh");
		expect(toolsForMode({ mode: "debug", permission: "auto", sshTools: true })).toContain("ssh");
		expect(toolsForMode({ mode: "subagent", permission: "auto", child: true, sshTools: true })).not.toContain("ssh");
		// The remote desktop rides with ssh: same hosts, same gate.
		expect(toolsForMode({ ...agent, sshTools: true })).toContain("remote_desktop");
		expect(toolsForMode({ ...agent, sshTools: true, permission: "read-only" })).not.toContain("remote_desktop");
		expect(toolsForMode(agent)).not.toContain("remote_desktop");
	});
});
