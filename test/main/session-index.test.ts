import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSessions, summarizeSessionFile } from "../../src/main/session-index";

function sessionFile(lines: unknown[]): string {
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function header(id: string, cwd: string, timestamp = "2024-01-02T03:04:05.000Z") {
	return { type: "session", version: 3, id, timestamp, cwd };
}

function message(role: "user" | "assistant" | "toolResult", content: unknown, timestamp: number) {
	return {
		type: "message",
		id: `m-${timestamp}`,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: { role, content, timestamp },
	};
}

test("a row keeps the opening prompt, the latest name and the last activity", async () => {
	const directory = mkdtempSync(join(tmpdir(), "neko-session-index-"));
	try {
		const file = join(directory, "one.jsonl");
		writeFileSync(file, sessionFile([
			header("s1", "D:/work/app"),
			message("user", "  Fix the\nlogin  ", 1_700_000_000_000),
			message("assistant", [{ type: "text", text: "Done" }], 1_700_000_005_000),
			{ type: "session_info", id: "i1", parentId: null, timestamp: "2024-01-02T03:04:06.000Z", name: "Login bug" },
			message("toolResult", "ignored", 1_700_000_009_000),
		]));
		const [row] = await collectSessions(directory);
		expect(row).toMatchObject({
			id: "s1",
			sessionFile: file,
			cwd: "D:/work/app",
			title: "Login bug",
			titlePending: false,
			preview: "Fix the login",
			createdAt: Date.parse("2024-01-02T03:04:05.000Z"),
			updatedAt: 1_700_000_005_000,
			messageCount: 3,
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an opening prompt stored as text blocks is still the title", async () => {
	const directory = mkdtempSync(join(tmpdir(), "neko-session-index-"));
	try {
		writeFileSync(join(directory, "one.jsonl"), sessionFile([
			header("s1", "/work"),
			message("user", [{ type: "text", text: "from a block" }, { type: "image", data: "abc" }], 1_700_000_000_000),
		]));
		const [row] = await collectSessions(directory);
		expect(row?.title).toBe("from a block");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an unnamed session titles itself from the opening prompt and has no preview", async () => {
	const directory = mkdtempSync(join(tmpdir(), "neko-session-index-"));
	try {
		writeFileSync(join(directory, "one.jsonl"), sessionFile([
			header("s1", "/work"),
			message("user", "hello \"world\"", 1_700_000_000_000),
		]));
		const [row] = await collectSessions(directory);
		expect(row?.title).toBe("hello \"world\"");
		expect(row?.preview).toBe("");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a cleared name falls back to the opening prompt", async () => {
	const directory = mkdtempSync(join(tmpdir(), "neko-session-index-"));
	try {
		writeFileSync(join(directory, "one.jsonl"), sessionFile([
			header("s1", "/work"),
			message("user", "original", 1_700_000_000_000),
			{ type: "session_info", id: "i1", parentId: null, timestamp: "2024-01-02T03:04:06.000Z", name: "Named" },
			{ type: "session_info", id: "i2", parentId: "i1", timestamp: "2024-01-02T03:04:07.000Z", name: "  " },
		]));
		const [row] = await collectSessions(directory);
		expect(row?.title).toBe("original");
		expect(row?.preview).toBe("");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an oversized payload is counted and never becomes the row text", async () => {
	const directory = mkdtempSync(join(tmpdir(), "neko-session-index-"));
	try {
		const file = join(directory, "one.jsonl");
		const payload = "x".repeat(2_000_000);
		writeFileSync(file, sessionFile([
			header("s1", "/work"),
			message("user", "ship the index", 1_700_000_000_000),
			message("toolResult", payload, 1_700_000_001_000),
			message("assistant", "shipped", 1_700_000_002_000),
		]));
		const summary = await summarizeSessionFile(file, 0);
		expect(summary).toMatchObject({
			id: "s1",
			firstMessage: "ship the index",
			messageCount: 3,
			updatedAt: 1_700_000_002_000,
		});
		expect(JSON.stringify(summary)).not.toContain(payload.slice(0, 32));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the opening of a huge first prompt is kept and the rest is not parsed", async () => {
	const directory = mkdtempSync(join(tmpdir(), "neko-session-index-"));
	try {
		const file = join(directory, "one.jsonl");
		const prompt = `${"a".repeat(80)} ${"b".repeat(500_000)}`;
		writeFileSync(file, sessionFile([
			header("s1", "/work"),
			message("user", prompt, 1_700_000_000_000),
		]));
		const [row] = await collectSessions(directory);
		expect(row?.title.startsWith("a".repeat(79))).toBe(true);
		expect(row?.title.endsWith("…")).toBe(true);
		expect(row?.messageCount).toBe(1);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("cwd selects one project and a file that is not a session is skipped", async () => {
	const directory = mkdtempSync(join(tmpdir(), "neko-session-index-"));
	try {
		writeFileSync(join(directory, "keep.jsonl"), sessionFile([
			header("keep", "D:/work/app"),
			message("user", "keep me", 1_700_000_000_000),
		]));
		writeFileSync(join(directory, "drop.jsonl"), sessionFile([
			header("drop", "D:/work/other"),
			message("user", "drop me", 1_700_000_000_100),
		]));
		writeFileSync(join(directory, "notes.jsonl"), "{\"type\":\"note\"}\n");
		const rows = await collectSessions(directory, "D:/work/app");
		expect(rows.map((row) => row.id)).toEqual(["keep"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an unchanged file is served from the index even if its bytes are replaced", async () => {
	const directory = mkdtempSync(join(tmpdir(), "neko-session-index-"));
	try {
		const file = join(directory, "one.jsonl");
		const indexPath = join(directory, ".nekocode-session-index.json");
		writeFileSync(file, sessionFile([
			header("s1", "/work"),
			message("user", "cached title", 1_700_000_000_000),
		]));
		const [first] = await collectSessions(directory);
		const stamp = statSync(file);
		writeFileSync(file, Buffer.alloc(stamp.size, 0x78));
		const replaced = statSync(file);
		const index = JSON.parse(readFileSync(indexPath, "utf8")) as { files: Record<string, { size: number; mtimeMs: number }> };
		index.files["one.jsonl"]!.size = replaced.size;
		index.files["one.jsonl"]!.mtimeMs = replaced.mtimeMs;
		writeFileSync(indexPath, JSON.stringify(index));
		const [cached] = await collectSessions(directory);
		expect(cached?.id).toBe("s1");
		expect(cached?.title).toBe(first?.title);
		utimesSync(file, replaced.atime, new Date(replaced.mtimeMs + 5000));
		expect(await collectSessions(directory)).toEqual([]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
