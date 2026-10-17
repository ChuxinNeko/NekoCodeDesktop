import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { Client } from "ssh2";
import type { SandboxDeployment } from "../../src/shared/ssh";
import { deploymentScript, deploySandbox, sandboxBundle } from "../../src/main/sandbox-deployment";

function host(run: (stream: EventEmitter & { stderr: EventEmitter }, script: string) => void): Client {
	return { exec(command: string, callback: Function) {
		expect(command).toBe("sh -s");
		const stream = Object.assign(new EventEmitter(), {
			stderr: new EventEmitter(), close() {},
			end(script: string) { run(stream, script); },
		});
		callback(null, stream);
	} } as unknown as Client;
}

describe("automatic sandbox deployment", () => {
	const python = Bun.which("python3") ?? Bun.which("python");
	test.skipIf(!python)("mirror selection rejects captive portals and incomplete security mirrors", () => {
		const result = spawnSync(python!, ["-c", `
import importlib.util
spec=importlib.util.spec_from_file_location('mirror',${JSON.stringify(resolve("server/sandbox/select-mirror.py"))})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Response:
 status=200
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,*args):return b'-----BEGIN PGP SIGNED MESSAGE-----\\nmetadata'
m.urllib.request.urlopen=lambda *args,**kwargs:Response()
assert m.probe('deb.debian.org')[1]=='deb.debian.org'
class Portal(Response):
 def read(self,*args):return b'<html>login required</html>'
m.urllib.request.urlopen=lambda *args,**kwargs:Portal()
assert m.probe('deb.debian.org') is None
def incomplete(request,**kwargs):
 if '/debian-security/' in request.full_url:raise OSError('unreachable')
 return Response()
m.urllib.request.urlopen=incomplete
assert m.probe('deb.debian.org') is None
`], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
	});
	test("ships the entire build context and a deterministic LF-normalized version", () => {
		const bundle = sandboxBundle();
		expect(bundle.version).toMatch(/^[a-f0-9]{64}$/);
		expect(bundle.version).toBe(sandboxBundle().version);
		for (const name of ["Dockerfile", "setup.sh", "entrypoint.py", "control.py", "network.py", "download-runtime.py", "session.sh", "sshd_config", ".dockerignore"]) expect(bundle.files[name]).toBeTruthy();
		expect(bundle.payload).not.toContain("\\r\\n");
		const script = deploymentScript(bundle);
		const encoded = script.match(/NEKOCODE_PAYLOAD='([^']+)'/)![1];
		expect(JSON.parse(Buffer.from(encoded, "base64").toString())).toEqual(bundle.files);
		expect(script).not.toContain("# NEKOCODE_PAYLOAD");
	});
	test("reports stages even when SSH splits a marker across packets", async () => {
		const events: SandboxDeployment[] = [];
		await deploySandbox(host(stream => {
			stream.emit("data", Buffer.from("NEKOCODE_STA"));
			stream.emit("data", Buffer.from("GE:runtime\nNEKOCODE_STAGE:image\n"));
			stream.emit("close", 0);
		}), "host", state => events.push(state));
		expect(events.map(state => state.phase)).toEqual(["checking", "runtime", "image", "ready"]);
	});
	test("consumes the full installer before a cached deployment can exit early", async () => {
		await deploySandbox(host((stream, script) => {
			expect(script.startsWith("nekocode_deploy() {\n")).toBe(true);
			expect(script.endsWith("\n}\nnekocode_deploy\n")).toBe(true);
			stream.emit("close", 0);
		}), "host", () => {});
	});
	test("a failed installation surfaces actionable stderr and never reports ready", async () => {
		const events: SandboxDeployment[] = [];
		await expect(deploySandbox(host(stream => {
			stream.stderr.emit("data", Buffer.from("At least 2 GiB available RAM is required"));
			stream.emit("close", 1);
		}), "host", state => events.push(state))).rejects.toThrow("2 GiB");
		expect(events.map(state => state.phase)).toEqual(["checking", "error"]);
	});
	test("a dropped SSH channel cannot be mistaken for successful installation", async () => {
		await expect(deploySandbox(host(stream => stream.emit("close", null)), "host", () => {})).rejects.toThrow("SSH connection closed");
	});
	test("transport errors reject immediately", async () => {
		await expect(deploySandbox(host(stream => stream.emit("error", new Error("lost transport"))), "host", () => {})).rejects.toThrow("lost transport");
	});
});
