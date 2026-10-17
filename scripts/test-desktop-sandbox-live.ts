/** Build with bun --target=node --format=cjs, then run with Electron (not Node).
 * Uses a temporary copy of saved SSH settings and a separate disposable sandbox.
 * Does not modify saved credentials, desktop mode, or the user's sandbox files.
 */
import { app, safeStorage, nativeImage } from "electron";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { SshStore } from "../src/main/ssh-store";
import { SshService } from "../src/main/ssh-service";
import { shellQuote } from "../src/main/posix-shell";
import { RemoteDesktopService } from "../src/main/remote-desktop/service";
import { accessibilityScript, accessibilityWrapper, parseAccessibility } from "../src/main/remote-desktop/accessibility";
import type { SandboxDeployment } from "../src/shared/ssh";

app.setName("NekoCode Desktop");
const userData = process.env.NEKOCODE_USER_DATA ?? join(app.getPath("appData"), "NekoCode Desktop");
app.setPath("userData", userData);
app.whenReady().then(async () => {
	const output = resolve(process.env.NEKOCODE_SANDBOX_RESULTS ?? "artifacts/gvisor-adaptation-20261017");
	mkdirSync(output, { recursive: true });
	const temporary = mkdtempSync(join(tmpdir(), "neko-sandbox-live-"));
	const saved = JSON.parse(readFileSync(join(userData, "ssh-hosts.json"), "utf8"));
	const target = process.env.NEKOCODE_SSH_HOST_ID
		? saved.hosts.find((host: { id: string }) => host.id === process.env.NEKOCODE_SSH_HOST_ID)
		: saved.hosts.length === 1 ? saved.hosts[0] : null;
	assert(target, "Set NEKOCODE_SSH_HOST_ID when more than one server is saved");
	const id = `${target.id}-sandbox-smoke`;
	writeFileSync(join(temporary, "ssh-hosts.json"), JSON.stringify({ version: 1, hosts: [{ ...target, id, desktopMode: "sandbox", sandboxDir: "/home/neko/workspace" }] }));
	const store = new SshStore(temporary, safeStorage);
	const deploymentEvents: SandboxDeployment[] = [];
	const ssh = new SshService(store, state => {
		deploymentEvents.push(state);
		console.log(`DEPLOY ${state.phase}${state.error ? ` ${state.error}` : ""}`);
	});
	const desktop = new RemoteDesktopService({ connect: hostId => ssh.dedicated(hostId), emit: () => {} });
	const results: Array<{ name: string; details?: unknown }> = [];
	const passed = (name: string, details?: unknown) => { results.push({ name, details }); console.log(`PASS ${name}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`); };
	let failed: string | undefined;
	const timeout = setTimeout(() => { console.error("Live smoke test timed out"); app.exit(1); }, 35 * 60_000);
	try {
		await ssh.prepareSandbox(id);
		assert.equal(deploymentEvents.at(-1)?.phase, "ready");
		passed("automatic deployment through verified SSH", deploymentEvents.map(state => state.phase));
		deploymentEvents.length = 0;
		await ssh.prepareSandbox(id);
		assert.equal(deploymentEvents.at(-1)?.phase, "ready");
		assert(!deploymentEvents.some(state => ["runtime", "image", "dependencies"].includes(state.phase)));
		passed("matching deployment reused without reinstall");
		const system = await ssh.exec(id, "uname -r; id -u; grep CapEff /proc/self/status; test ! -e /opt/nekocode-sandbox/source/setup.sh && echo HOST_FILES_HIDDEN");
		assert.equal(system.code, 0); assert.match(system.stdout, /gvisor/); assert.match(system.stdout, /1000/); assert.match(system.stdout, /HOST_FILES_HIDDEN/);
		passed("guest execution and host-file isolation", system.stdout.trim());
		const source = join(temporary, "upload.txt"), downloaded = join(temporary, "download.txt");
		writeFileSync(source, "neko-sandbox-transfer-check\n");
		await ssh.upload(id, source, "live-check.txt");
		const listing = await ssh.list(id, "."); assert(listing.entries.some(entry => entry.name === "live-check.txt"));
		await ssh.download(id, "live-check.txt", downloaded); assert.equal(readFileSync(downloaded, "utf8"), readFileSync(source, "utf8"));
		passed("SFTP upload, listing and download");
		const terminal = await ssh.shell(id, { cols: 80, rows: 24 });
		await new Promise<void>((resolve, reject) => {
			let text = ""; const timer = setTimeout(() => reject(new Error("Terminal test timed out")), 15_000);
			terminal.channel.on("data", (data: Buffer) => { text += data; if (text.includes("INNER_TERMINAL_OK")) { clearTimeout(timer); resolve(); } });
			terminal.channel.write("printf 'INNER_%s_OK\\n' TERMINAL\n");
		});
		terminal.close(); passed("interactive sandbox terminal");
		const state = await desktop.connect(id, "agent"); assert(state.width > 0 && state.height > 0);
		passed("SSH tunnel to sandbox VNC", { width: state.width, height: state.height });
		const info = await desktop.resolutionInfo(id); assert(info.modes.length > 0);
		await desktop.setResolution(id, 1024, 768); assert.equal(desktop.state(id)?.width, 1024);
		await desktop.setResolution(id, 1280, 800); passed("RandR resize and live VNC resize events");
		const browser = await ssh.exec(id, "setsid -f chromium --force-renderer-accessibility --disable-gpu --no-first-run --user-data-dir=/home/neko/smoke-chrome https://example.com >/tmp/neko-browser.log 2>&1 </dev/null");
		assert.equal(browser.code, 0);
		await new Promise(resolve => setTimeout(resolve, 7000));
		const elementsText = await desktop.run(id, `sh -c ${shellQuote(accessibilityWrapper(":1"))}`, accessibilityScript({ limit: 150, query: "", width: 1280, height: 800 }), 20_000);
		const elements = parseAccessibility(elementsText); assert(elements.elements.length > 0);
		passed("AT-SPI accessibility tree inside sandbox", { elements: elements.elements.length });
		const internet = await ssh.exec(id, "curl -fsSL --max-time 25 https://example.com");
		assert.equal(internet.code, 0, internet.stderr);
		assert.match(internet.stdout, /Example Domain/i); passed("public HTTPS egress");
		const networkTest = `import socket,json\nr={}\nfor host in ${JSON.stringify([target.host, "169.254.169.254", "10.0.0.1"])}:\n s=socket.socket();s.settimeout(2);r[host]=s.connect_ex((host,22 if host==${JSON.stringify(target.host)} else 80));s.close()\nprint(json.dumps(r))`;
		const blocked = await ssh.exec(id, `python3 -c ${shellQuote(networkTest)}`);
		const denied = JSON.parse(blocked.stdout); assert(Object.values(denied).every(code => code !== 0)); passed("host SSH, metadata and private network blocked", denied);
		const readonly = await ssh.exec(id, "touch /etc/neko-must-not-write 2>/dev/null; result=$?; test $result -ne 0");
		assert.equal(readonly.code, 0); passed("immutable system filesystem");
		const rfb = await desktop.agent(id);
		const bgra = Buffer.from(rfb.framebuffer);
		for (let i = 0; i < bgra.length; i += 4) { const red = bgra[i]; bgra[i] = bgra[i + 2]; bgra[i + 2] = red; }
		writeFileSync(join(output, "desktop.png"), nativeImage.createFromBitmap(bgra, { width: rfb.width, height: rfb.height }).toPNG());
		desktop.disconnect(id);
		await ssh.manageSandbox(id, "stop");
		const resumed = await ssh.exec(id, "cat live-check.txt"); assert.match(resumed.stdout, /neko-sandbox-transfer-check/); passed("pause and resume preserve sandbox files");
		await ssh.manageSandbox(id, "reset");
		const reset = await ssh.exec(id, "test ! -e live-check.txt && uname -r"); assert.equal(reset.code, 0); assert.match(reset.stdout, /gvisor/); passed("reset creates a clean sandbox");
	} catch (error) { failed = error instanceof Error ? error.stack ?? error.message : String(error); console.error(failed); }
	finally {
		desktop.disconnectAll();
		try { await ssh.manageSandbox(id, "reset"); passed("disposable sandbox removed"); } catch (error) { failed ??= `Cleanup failed: ${String(error)}`; }
		ssh.disconnectAll(); clearTimeout(timeout);
		writeFileSync(join(output, "results.json"), JSON.stringify({ passed: !failed, results, error: failed }, null, 2));
		rmSync(temporary, { recursive: true, force: true });
	}
	app.exit(failed ? 1 : 0);
}).catch(error => { console.error(error.message); app.exit(1); });
