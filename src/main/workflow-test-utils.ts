import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

export function workflowSandbox() {
	const tempRoot = realpathSync(tmpdir());
	const root = mkdtempSync(join(tempRoot, "nekocode-workflow-test-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	return {
		root,
		cwd,
		agentDir,
		cleanup() {
			const target = realpathSync(root);
			if (
				!target.startsWith(resolve(tempRoot) + sep) ||
				!basename(target).startsWith("nekocode-workflow-test-")
			)
				throw new Error("Refusing unsafe test cleanup");
			rmSync(target, { recursive: true, force: true });
		},
	};
}
export async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
	const until = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > until) throw new Error("Timed out waiting for workflow state");
		await Bun.sleep(10);
	}
}
