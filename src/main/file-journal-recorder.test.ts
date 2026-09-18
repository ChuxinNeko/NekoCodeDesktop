import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { FILE_MUTATION_ENTRY, MAX_PREIMAGE_BYTES, unpackPreimage, type FileMutationData } from "./file-journal";
import { FileJournalRecorder } from "./file-journal-recorder";

const temporaries: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(realpathSync(tmpdir()), "nekocode-recorder-"));
	temporaries.push(dir);
	return dir;
}

function write(root: string, relativePath: string, contents: string): void {
	const target = join(root, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents);
}

/** A stand-in for the session, capturing only what the recorder appends to it. */
function fakeSession(): { session: AgentSession; appended: { type: string; data: FileMutationData }[] } {
	const appended: { type: string; data: FileMutationData }[] = [];
	const session = {
		sessionManager: {
			appendCustomEntry: (customType: string, data: unknown) => {
				appended.push({ type: customType, data: data as FileMutationData });
				return "entry-id";
			},
		},
	} as unknown as AgentSession;
	return { session, appended };
}

afterEach(() => {
	const tempRoot = resolve(realpathSync(tmpdir()));
	for (const dir of temporaries.splice(0)) {
		const target = resolve(dir);
		if (!target.startsWith(tempRoot + sep) || !basename(target).startsWith("nekocode-recorder-")) {
			throw new Error(`Refusing unsafe test cleanup: ${target}`);
		}
		rmSync(target, { recursive: true, force: true });
	}
});

describe("FileJournalRecorder", () => {
	test("records the contents a write is about to replace", async () => {
		const cwd = scratch();
		write(cwd, "src/a.ts", "the original");
		const recorder = new FileJournalRecorder(cwd);
		const { session, appended } = fakeSession();

		await recorder.beforeTool("call-1", "write", { path: "src/a.ts", content: "new" });
		recorder.afterTool(session, "call-1", false);

		expect(appended).toHaveLength(1);
		expect(appended[0].type).toBe(FILE_MUTATION_ENTRY);
		expect(appended[0].data.path).toBe("src/a.ts");
		expect(appended[0].data.beforeBytes).toBe("the original".length);
		expect(unpackPreimage(appended[0].data.before!).toString()).toBe("the original");
	});

	test("a file the tool is creating records absence, which undoes as a delete", async () => {
		const cwd = scratch();
		const recorder = new FileJournalRecorder(cwd);
		const { session, appended } = fakeSession();

		await recorder.beforeTool("call-1", "write", { path: "src/new.ts", content: "x" });
		recorder.afterTool(session, "call-1", false);

		expect(appended[0].data.before).toBeNull();
		expect(appended[0].data.beforeBytes).toBe(0);
	});

	test("edit is recorded the same way write is", async () => {
		const cwd = scratch();
		write(cwd, "a.ts", "before");
		const recorder = new FileJournalRecorder(cwd);
		const { session, appended } = fakeSession();

		await recorder.beforeTool("call-1", "edit", { path: "a.ts", edits: [] });
		recorder.afterTool(session, "call-1", false);

		expect(appended[0].data.tool).toBe("edit");
	});

	test("a failed tool changed nothing, so nothing is recorded", async () => {
		const cwd = scratch();
		write(cwd, "a.ts", "before");
		const recorder = new FileJournalRecorder(cwd);
		const { session, appended } = fakeSession();

		await recorder.beforeTool("call-1", "write", { path: "a.ts", content: "x" });
		recorder.afterTool(session, "call-1", true);

		expect(appended).toEqual([]);
	});

	test("tools that name no file are ignored", async () => {
		const cwd = scratch();
		const recorder = new FileJournalRecorder(cwd);
		const { session, appended } = fakeSession();

		await recorder.beforeTool("call-1", "bash", { command: "rm -rf build" });
		await recorder.beforeTool("call-2", "read", { path: "a.ts" });
		recorder.afterTool(session, "call-1", false);
		recorder.afterTool(session, "call-2", false);

		expect(appended).toEqual([]);
	});

	test("a path outside the workspace is not recorded", async () => {
		const cwd = scratch();
		const recorder = new FileJournalRecorder(cwd);
		const { session, appended } = fakeSession();

		await recorder.beforeTool("call-1", "write", { path: "../outside.txt", content: "x" });
		recorder.afterTool(session, "call-1", false);

		expect(appended).toEqual([]);
	});

	test("an absolute path inside the workspace is recorded, relative to it", async () => {
		const cwd = scratch();
		write(cwd, "nested/a.ts", "before");
		const recorder = new FileJournalRecorder(cwd);
		const { session, appended } = fakeSession();

		await recorder.beforeTool("call-1", "write", { path: join(cwd, "nested", "a.ts"), content: "x" });
		recorder.afterTool(session, "call-1", false);

		// Forward slashes, so the record reads the same on either platform.
		expect(appended[0].data.path).toBe("nested/a.ts");
	});

	test("a file too large to keep is noted rather than copied", async () => {
		const cwd = scratch();
		write(cwd, "huge.bin", "x".repeat(MAX_PREIMAGE_BYTES + 1));
		const recorder = new FileJournalRecorder(cwd);
		const { session, appended } = fakeSession();

		await recorder.beforeTool("call-1", "write", { path: "huge.bin", content: "x" });
		recorder.afterTool(session, "call-1", false);

		expect(appended[0].data.skipped).toBe("too-large");
		expect(appended[0].data.before).toBeNull();
		expect(appended[0].data.beforeBytes).toBe(MAX_PREIMAGE_BYTES + 1);
	});

	test("two calls in flight at once do not mix up their files", async () => {
		const cwd = scratch();
		write(cwd, "a.ts", "contents of a");
		write(cwd, "b.ts", "contents of b");
		const recorder = new FileJournalRecorder(cwd);
		const { session, appended } = fakeSession();

		await recorder.beforeTool("call-a", "write", { path: "a.ts", content: "x" });
		await recorder.beforeTool("call-b", "write", { path: "b.ts", content: "y" });
		recorder.afterTool(session, "call-b", false);
		recorder.afterTool(session, "call-a", false);

		expect(appended.map((record) => record.data.path)).toEqual(["b.ts", "a.ts"]);
		expect(unpackPreimage(appended[0].data.before!).toString()).toBe("contents of b");
		expect(unpackPreimage(appended[1].data.before!).toString()).toBe("contents of a");
	});

	test("a call is only recorded once", async () => {
		const cwd = scratch();
		write(cwd, "a.ts", "before");
		const recorder = new FileJournalRecorder(cwd);
		const { session, appended } = fakeSession();

		await recorder.beforeTool("call-1", "write", { path: "a.ts", content: "x" });
		recorder.afterTool(session, "call-1", false);
		recorder.afterTool(session, "call-1", false);

		expect(appended).toHaveLength(1);
	});

	test("reset drops pre-images for calls that never reported back", async () => {
		const cwd = scratch();
		write(cwd, "a.ts", "before");
		const recorder = new FileJournalRecorder(cwd);
		const { session, appended } = fakeSession();

		await recorder.beforeTool("call-1", "write", { path: "a.ts", content: "x" });
		recorder.reset();
		recorder.afterTool(session, "call-1", false);

		expect(appended).toEqual([]);
	});
});
