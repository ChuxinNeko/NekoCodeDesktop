import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { workflowSandbox } from "./workflow-test-utils";

test("shared desktop session store lists both workspaces and reopens with the recorded cwd", async () => {
	const sandbox = workflowSandbox();
	try {
		const second = join(sandbox.root, "second"); mkdirSync(second);
		const sessionsDir = join(sandbox.root, "sessions");
		for (const cwd of [sandbox.cwd, second]) {
			const manager = SessionManager.create(cwd, sessionsDir);
			manager.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "OK" }], api: "antigravity", provider: "test", model: "test", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		}
		const all = await SessionManager.listAll(sessionsDir);
		expect(all).toHaveLength(2);
		expect(new Set(all.map((entry) => entry.cwd))).toEqual(new Set([sandbox.cwd, second]));
		expect(await SessionManager.list(sandbox.cwd, sessionsDir)).toHaveLength(1);
		const other = all.find((entry) => entry.cwd === second)!;
		expect(SessionManager.open(other.path, sessionsDir, other.cwd).getCwd()).toBe(second);
	} finally { sandbox.cleanup(); }
});
