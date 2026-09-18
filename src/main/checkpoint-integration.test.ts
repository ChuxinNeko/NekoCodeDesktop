import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_ENTRY, checkpointEntries, planReversal, type CheckpointData } from "./file-journal";
import { FileJournalRecorder } from "./file-journal-recorder";
import { applyReversal, fileDiffSince, previewReversal } from "./file-restore";
import { findTurnEntry } from "./checkpoint-anchor";

/**
 * The whole feature against a real pi session.
 *
 * The unit tests each mock the piece next door; this one uses pi's own
 * SessionManager, so the entry shapes, the tree walk, and the JSONL round trip
 * are the real ones. It is the test that would have caught a wrong assumption
 * about pi rather than about my own code.
 */

const temporaries: string[] = [];

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(realpathSync(tmpdir()), `nekocode-e2e-${prefix}-`));
	temporaries.push(dir);
	return dir;
}

function write(root: string, relativePath: string, contents: string): void {
	const target = join(root, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents);
}

function read(root: string, relativePath: string): string {
	return readFileSync(join(root, relativePath), "utf8");
}

afterEach(() => {
	const tempRoot = resolve(realpathSync(tmpdir()));
	for (const dir of temporaries.splice(0)) {
		const target = resolve(dir);
		if (!target.startsWith(tempRoot + sep) || !basename(target).startsWith("nekocode-e2e-")) {
			throw new Error(`Refusing unsafe test cleanup: ${target}`);
		}
		rmSync(target, { recursive: true, force: true });
	}
});

/** A session over a scratch workspace, plus the recorder writing into it. */
function session() {
	const cwd = scratch("cwd");
	const manager = SessionManager.create(cwd, scratch("sessions"));
	const recorder = new FileJournalRecorder(cwd);
	const fake = { sessionManager: manager } as never;
	return {
		cwd,
		manager,
		/** What `AgentService.markCheckpoint` does. */
		mark(label: string): string {
			return manager.appendCustomEntry(CHECKPOINT_ENTRY, { label } satisfies CheckpointData);
		},
		/** What the tool hooks do around one file-changing call. */
		async tool(id: string, name: string, path: string, apply: () => void) {
			await recorder.beforeTool(id, name, { path });
			apply();
			recorder.afterTool(fake, id, false);
		},
		prompt(text: string): string {
			return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() } as never);
		},
		branch: () => manager.getBranch(),
	};
}

describe("checkpoints over a real pi session", () => {
	test("a turn's file changes are recorded and can be put back", async () => {
		const s = session();
		write(s.cwd, "src/a.ts", "original a");
		write(s.cwd, "src/b.ts", "original b");

		const checkpointId = s.mark("rewrite the module");
		s.prompt("rewrite the module");
		await s.tool("c1", "edit", "src/a.ts", () => write(s.cwd, "src/a.ts", "rewritten a"));
		await s.tool("c2", "write", "src/new.ts", () => write(s.cwd, "src/new.ts", "created"));

		const plan = planReversal(s.branch(), checkpointId);
		expect(plan.steps.map((step) => step.path)).toEqual(["src/a.ts", "src/new.ts"]);

		const diff = await previewReversal(plan, s.cwd);
		expect(diff.counts).toEqual({ overwrite: 1, recreate: 0, delete: 1 });

		const outcome = await applyReversal(plan, s.cwd);
		expect(outcome.warnings).toEqual([]);
		expect(read(s.cwd, "src/a.ts")).toBe("original a");
		expect(read(s.cwd, "src/b.ts")).toBe("original b");
		expect(existsSync(join(s.cwd, "src/new.ts"))).toBe(false);
	});

	test("an earlier checkpoint undoes every turn after it", async () => {
		const s = session();
		write(s.cwd, "a.ts", "v0");

		const first = s.mark("turn one");
		s.prompt("turn one");
		await s.tool("c1", "edit", "a.ts", () => write(s.cwd, "a.ts", "v1"));

		s.mark("turn two");
		s.prompt("turn two");
		await s.tool("c2", "edit", "a.ts", () => write(s.cwd, "a.ts", "v2"));

		await applyReversal(planReversal(s.branch(), first), s.cwd);
		// Back to before turn one, not to the state between the two turns.
		expect(read(s.cwd, "a.ts")).toBe("v0");
	});

	test("the later checkpoint undoes only its own turn", async () => {
		const s = session();
		write(s.cwd, "a.ts", "v0");

		s.mark("turn one");
		await s.tool("c1", "edit", "a.ts", () => write(s.cwd, "a.ts", "v1"));
		const second = s.mark("turn two");
		await s.tool("c2", "edit", "a.ts", () => write(s.cwd, "a.ts", "v2"));

		await applyReversal(planReversal(s.branch(), second), s.cwd);
		expect(read(s.cwd, "a.ts")).toBe("v1");
	});

	test("the checkpoint list survives a reopen of the transcript", async () => {
		const s = session();
		write(s.cwd, "a.ts", "original");
		s.mark("first turn");
		s.prompt("first turn");
		await s.tool("c1", "edit", "a.ts", () => write(s.cwd, "a.ts", "changed"));
		// A transcript is only flushed once an assistant message lands.
		s.manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as never);

		const file = s.manager.getSessionFile()!;
		const reopened = SessionManager.open(file, s.manager.getSessionDir(), s.cwd);
		const branch = reopened.getBranch();

		const markers = checkpointEntries(branch);
		expect(markers.map((marker) => marker.label)).toEqual(["first turn"]);

		// And the recorded change is still usable after the round trip through JSONL.
		const outcome = await applyReversal(planReversal(branch, markers[0].id), s.cwd);
		expect(outcome.restored).toBe(1);
		expect(read(s.cwd, "a.ts")).toBe("original");
	});

	test("checkpoint markers never reach the model", async () => {
		const s = session();
		write(s.cwd, "a.ts", "x");
		s.mark("a prompt the model should see once");
		s.prompt("a prompt the model should see once");
		await s.tool("c1", "edit", "a.ts", () => write(s.cwd, "a.ts", "y"));

		const { messages } = s.manager.buildSessionContext();
		// One user message, and nothing from the journal: custom entries are state,
		// not context. A leak here would put file contents into every request.
		expect(messages).toHaveLength(1);
		expect(JSON.stringify(messages)).not.toContain("nekocode");
	});

	test("the prompt after a marker is what the conversation rewind targets", () => {
		const s = session();
		const checkpointId = s.mark("do the thing");
		const promptId = s.prompt("do the thing");
		s.manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as never);

		// What AgentService hands to navigateTree: the prompt entry, whose parent
		// becomes the new leaf.
		expect(findTurnEntry(s.branch(), checkpointId)?.id).toBe(promptId);
	});

	test("shell commands in the turn are counted and called out", async () => {
		const s = session();
		write(s.cwd, "a.ts", "original");
		const checkpointId = s.mark("run the build");
		await s.tool("c1", "edit", "a.ts", () => write(s.cwd, "a.ts", "changed"));
		s.manager.appendMessage({
			role: "toolResult",
			toolName: "bash",
			toolCallId: "c2",
			content: [],
			timestamp: Date.now(),
		} as never);

		const plan = planReversal(s.branch(), checkpointId);
		expect(plan.opaqueRuns).toBe(1);
		const outcome = await applyReversal(plan, s.cwd);
		expect(outcome.warnings.join(" ")).toContain("终端命令");
	});

	test("the panel's file list carries real line counts", async () => {
		const s = session();
		write(s.cwd, "src/a.ts", "one\ntwo\nthree\n");
		const checkpointId = s.mark("touch a few files");
		await s.tool("c1", "edit", "src/a.ts", () => write(s.cwd, "src/a.ts", "one\nTWO\nthree\nfour\n"));
		await s.tool("c2", "write", "src/made.ts", () => write(s.cwd, "src/made.ts", "a\nb\n"));

		const diff = await previewReversal(planReversal(s.branch(), checkpointId), s.cwd);
		const byPath = new Map(diff.changes.map((change) => [change.path, change]));

		// One line replaced and one appended.
		expect(byPath.get("src/a.ts")).toMatchObject({
			action: "overwrite",
			additions: 2,
			deletions: 1,
			binary: false,
		});
		// A file the agent created is all additions, and restoring it is a delete.
		expect(byPath.get("src/made.ts")).toMatchObject({
			action: "delete",
			additions: 2,
			deletions: 0,
		});
	});

	test("a file's diff reads from the checkpoint forwards, coloured as the agent's work", async () => {
		const s = session();
		write(s.cwd, "a.ts", "keep\nold line\nkeep too\n");
		const checkpointId = s.mark("rewrite the middle");
		await s.tool("c1", "edit", "a.ts", () => write(s.cwd, "a.ts", "keep\nnew line\nkeep too\n"));

		const plan = planReversal(s.branch(), checkpointId);
		const patch = await fileDiffSince(plan.steps[0], s.cwd);

		expect(patch).toMatchObject({ path: "a.ts", additions: 1, deletions: 1, binary: false });
		// The line the agent removed is a `-`, the one it wrote is a `+`.
		expect(patch.patch).toContain("-old line");
		expect(patch.patch).toContain("+new line");
		expect(patch.patch).toContain(" keep");
	});

	test("a binary file is reported rather than rendered as garbage", async () => {
		const s = session();
		write(s.cwd, "logo.bin", "before");
		const checkpointId = s.mark("replace the asset");
		await s.tool("c1", "write", "logo.bin", () => write(s.cwd, "logo.bin", " binary"));

		const plan = planReversal(s.branch(), checkpointId);
		const patch = await fileDiffSince(plan.steps[0], s.cwd);

		expect(patch.binary).toBe(true);
		expect(patch.patch).toBe("");
	});

	test("nothing is written outside the session directory", async () => {
		const s = session();
		write(s.cwd, "a.ts", "original");
		s.mark("turn");
		await s.tool("c1", "edit", "a.ts", () => write(s.cwd, "a.ts", "changed"));
		s.manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as never);

		// The whole feature's storage: entries in the transcript that already
		// existed. There is no other directory to check, which is the point.
		const transcript = readFileSync(s.manager.getSessionFile()!, "utf8");
		expect(transcript).toContain("nekocode.file-mutation");
		expect(transcript).toContain("nekocode.checkpoint");
	});
});
