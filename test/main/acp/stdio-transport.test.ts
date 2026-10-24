import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { StdioTransport } from "../../../src/main/acp/stdio-transport";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test.skipIf(process.platform !== "win32")("closing an ACP transport terminates its owned parent and descendant on Windows", async () => {
	let owned: { parent: number; descendant: number } | undefined;
	const transport = new StdioTransport({
		command: process.execPath,
		args: ["-e", `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" }); console.log(JSON.stringify({ parent: process.pid, descendant: child.pid })); setInterval(() => {}, 1000);`],
		cwd: tmpdir(), env: {}, shell: false,
	});
	try {
		owned = await new Promise<{ parent: number; descendant: number }>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("test process startup timed out")), 5000);
			transport.onMessage((message) => { clearTimeout(timer); resolve(message as { parent: number; descendant: number }); });
			transport.onClose((reason) => { clearTimeout(timer); reject(new Error(reason)); });
		});
		expect(alive(owned.parent)).toBe(true);
		expect(alive(owned.descendant)).toBe(true);
		transport.close();
		const deadline = Date.now() + 5000;
		while ((alive(owned.parent) || alive(owned.descendant)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		expect(alive(owned.parent)).toBe(false);
		expect(alive(owned.descendant)).toBe(false);
	} finally {
		transport.close();
		// Only PIDs created by this test; never touch other Codex/user processes.
		if (owned) for (const pid of [owned.descendant, owned.parent]) { try { process.kill(pid); } catch {} }
	}
}, 12000);
