import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { FILE_MUTATION_ENTRY, reportPreimage, unpackPreimage, type FileMutationData } from "../../src/main/file-journal";
import { FileJournalRecorder } from "../../src/main/file-journal-recorder";

function fakeSession() {
	const entries: FileMutationData[] = [];
	const session = {
		sessionManager: {
			appendCustomEntry: (type: string, data: FileMutationData) => {
				if (type === FILE_MUTATION_ENTRY) entries.push(data);
			},
		},
	} as unknown as AgentSession;
	return { session, entries };
}

describe("FileJournalRecorder with reported pre-images", () => {
	test("notifies after a tool's records are committed, including reported deletions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nekocode-journal-"));
		try {
			const { session, entries } = fakeSession();
			const notifications: number[] = [];
			const recorder = new FileJournalRecorder(cwd, () => notifications.push(entries.length));
			writeFileSync(join(cwd, "a.ts"), "old\n");
			await recorder.beforeTool("write-1", "write", { path: "a.ts" });
			writeFileSync(join(cwd, "a.ts"), "new\nextra\n");
			await recorder.afterTool(session, "write-1", false);
			expect(notifications).toEqual([1]);
			expect(entries[0]).toMatchObject({ additions: 2, deletions: 1 });
			await recorder.afterTool(session, "read-1", false);
			expect(notifications).toEqual([1]);
			reportPreimage("delete-1", { tool: "custom-delete", path: join(cwd, "a.ts"), before: Buffer.from("new\nextra\n") });
			unlinkSync(join(cwd, "a.ts"));
			await recorder.afterTool(session, "delete-1", false);
			expect(notifications).toEqual([1, 2]);
			expect(entries[1]).toMatchObject({ additions: 0, deletions: 2 });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("helper hooks preserve the gate and after hook, then detach without retaining pending calls", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nekocode-journal-"));
		try {
			writeFileSync(join(cwd, "code.ts"), "original\n");
			const { session: parent, entries } = fakeSession();
			const before = async () => ({ block: true, reason: "denied" });
			let afterCalls = 0;
			const after = async () => { afterCalls++; return undefined; };
			const child = { agent: { beforeToolCall: before, afterToolCall: after } } as unknown as AgentSession;
			const recorder = new FileJournalRecorder(cwd);
			const detach = recorder.attach(child, parent);
			const context = { toolCall: { id: "blocked", name: "edit" }, args: { path: "code.ts" } };
			expect(await child.agent.beforeToolCall!(context as never)).toEqual({ block: true, reason: "denied" });
			await child.agent.afterToolCall!({ ...context, isError: false } as never);
			expect(entries).toEqual([]);
			expect(afterCalls).toBe(1);
			// An aborted tool must not leave a pending pre-image for a later lease.
			await recorder.beforeTool("aborted", "edit", { path: "code.ts" });
			detach();
			expect(child.agent.beforeToolCall).toBe(before);
			expect(child.agent.afterToolCall).toBe(after);
			await recorder.afterTool(parent, "aborted", false);
			expect(entries).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("records every file a multi-file tool reported, even when the call then failed", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nekocode-journal-"));
		try {
			writeFileSync(join(cwd, "a.ts"), "after a\n");
			writeFileSync(join(cwd, "b.ts"), "after b\nmore\n");
			reportPreimage("call-1", { tool: "ast_edit", path: join(cwd, "a.ts"), before: Buffer.from("before a\n") });
			reportPreimage("call-1", { tool: "ast_edit", path: join(cwd, "b.ts"), before: Buffer.from("before b\n") });
			// Outside the workspace: never recorded, so a restore can never write there.
			reportPreimage("call-1", { tool: "ast_edit", path: join(tmpdir(), "elsewhere.ts"), before: Buffer.from("x") });
			const { session, entries } = fakeSession();
			await new FileJournalRecorder(cwd).afterTool(session, "call-1", true);
			expect(entries.map((entry) => [entry.path, entry.tool, entry.additions, entry.deletions])).toEqual([
				["a.ts", "ast_edit", 1, 1],
				["b.ts", "ast_edit", 2, 1],
			]);
			expect(unpackPreimage(entries[0].before as string).toString()).toBe("before a\n");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("a conflict:// write is recorded by the file it changed, not by its URI", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nekocode-journal-"));
		try {
			writeFileSync(join(cwd, "code.ts"), "resolved\n");
			const recorder = new FileJournalRecorder(cwd);
			await recorder.beforeTool("call-2", "write", { path: "conflict://1", content: "@ours" });
			const before = Buffer.from("<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n");
			reportPreimage("call-2", { tool: "write", path: join(cwd, "code.ts"), before });
			const { session, entries } = fakeSession();
			await recorder.afterTool(session, "call-2", false);
			expect(entries.map((entry) => entry.path)).toEqual(["code.ts"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
