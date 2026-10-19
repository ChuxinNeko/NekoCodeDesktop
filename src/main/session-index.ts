import { open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { basename, join, resolve } from "node:path";
import type { SessionSummary } from "../shared/agent";
import { normalizeLine, sessionTitle } from "../shared/sessions";

/**
 * Sidebar index for the session directory.
 *
 * A row needs a title, a short preview and a time. `SessionManager.list` builds
 * those by parsing every transcript line and joining every message into one
 * string, which is what froze the window once the boot splash had already gone.
 * This reads the header, the name and the opening prompt, counts messages, and
 * skips the body of any line too large to be one of those. Unchanged files are
 * answered from the index, so the next launch stats the directory and stops.
 */

const INDEX_VERSION = 1;
const INDEX_NAME = ".nekocode-session-index.json";
/** Lines under this are real metadata and parse as JSON. Larger ones are payloads. */
const PARSE_LIMIT = 16 * 1024;
/** How much of an oversized line can still hold its type, role and opening text. */
const HEAD_BYTES = 8192;
/** Opening text kept for the title (80) and the preview (160), with room to spare. */
const TEXT_KEEP = 2000;
const READ_SIZE = 64 * 1024;
const CONCURRENCY = 4;

interface Scan {
	invalid: boolean;
	id: string;
	cwd: string;
	createdAt: number;
	/** Latest session name. `null` means a session_info entry cleared it. */
	name: string | null;
	firstMessage: string;
	messageCount: number;
	lastActivity: number;
}

interface IndexEntry {
	size: number;
	mtimeMs: number;
	id: string;
	cwd: string;
	name: string | null;
	firstMessage: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
}

interface IndexFile {
	version: number;
	files: Record<string, IndexEntry>;
}

export async function collectSessions(directory: string, cwd?: string): Promise<SessionSummary[]> {
	let names: string[];
	try {
		names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const index = await readIndex(directory);
	const next: Record<string, IndexEntry> = {};
	let dirty = false;
	const rows: SessionSummary[] = [];
	await mapPool(names, CONCURRENCY, async (name) => {
		const path = join(directory, name);
		let info: { size: number; mtimeMs: number };
		try {
			const fileStat = await stat(path);
			if (!fileStat.isFile()) return;
			info = { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
		} catch {
			dirty = true;
			return;
		}
		const cached = index.files[name];
		let entry = isIndexEntry(cached) && cached.size === info.size && cached.mtimeMs === info.mtimeMs ? cached : undefined;
		if (!entry) {
			dirty = true;
			const summary = await summarizeSessionFile(path, info.mtimeMs).catch(() => null);
			if (!summary) return;
			entry = { ...summary, size: info.size, mtimeMs: info.mtimeMs };
		}
		next[name] = entry;
		if (cwd && !sameDirectory(entry.cwd, cwd)) return;
		rows.push(toSummary(path, entry));
	});
	if (dirty || Object.keys(index.files).length !== Object.keys(next).length) {
		await writeIndex(directory, { version: INDEX_VERSION, files: next });
	}
	rows.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionFile.localeCompare(b.sessionFile));
	return rows;
}

/** One transcript, reduced to the fields a sidebar row stores. Exported for tests. */
export async function summarizeSessionFile(
	filePath: string,
	mtimeMs: number,
): Promise<Omit<IndexEntry, "size" | "mtimeMs"> | null> {
	const scan = emptyScan();
	const file = await open(filePath, "r");
	const decoder = new StringDecoder("utf8");
	const buffer = Buffer.allocUnsafe(READ_SIZE);
	let pending = "";
	let skipping = false;
	let head = "";
	try {
		let offset = 0;
		for (;;) {
			if (scan.invalid) break;
			const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			({ pending, skipping, head } = takeChunk(scan, pending, skipping, head, chunk));
		}
		const rest = decoder.end();
		if (rest) ({ pending, skipping, head } = takeChunk(scan, pending, skipping, head, rest));
		if (skipping) consumeLarge(scan, head);
		else if (pending) consumeLine(scan, pending);
	} finally {
		await file.close();
	}
	if (scan.invalid || !scan.id) return null;
	const updatedAt = scan.lastActivity > 0 ? scan.lastActivity : scan.createdAt || mtimeMs;
	return {
		id: scan.id,
		cwd: scan.cwd,
		name: scan.name,
		firstMessage: scan.firstMessage,
		createdAt: scan.createdAt || mtimeMs,
		updatedAt,
		messageCount: scan.messageCount,
	};
}

function emptyScan(): Scan {
	return { invalid: false, id: "", cwd: "", createdAt: 0, name: null, firstMessage: "", messageCount: 0, lastActivity: 0 };
}

function takeChunk(
	scan: Scan,
	pending: string,
	skipping: boolean,
	head: string,
	chunk: string,
): { pending: string; skipping: boolean; head: string } {
	let text = chunk;
	if (skipping) {
		const newline = text.indexOf("\n");
		if (newline === -1) return { pending, skipping, head };
		consumeLarge(scan, head);
		skipping = false;
		head = "";
		text = text.slice(newline + 1);
	}
	pending += text;
	let start = 0;
	for (;;) {
		const newline = pending.indexOf("\n", start);
		if (newline === -1) break;
		consumeLine(scan, pending.slice(start, newline));
		start = newline + 1;
	}
	pending = pending.slice(start);
	if (pending.length > PARSE_LIMIT) {
		skipping = true;
		head = pending.slice(0, HEAD_BYTES);
		pending = "";
	}
	return { pending, skipping, head };
}

function consumeLine(scan: Scan, line: string): void {
	if (scan.invalid) return;
	const trimmed = line.trim();
	if (!trimmed) return;
	if (trimmed.length > PARSE_LIMIT) {
		consumeLarge(scan, trimmed.slice(0, HEAD_BYTES));
		return;
	}
	let entry: unknown;
	try {
		entry = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (!entry || typeof entry !== "object") return;
	const record = entry as Record<string, unknown>;
	if (!scan.id) {
		if (record.type !== "session" || typeof record.id !== "string") {
			scan.invalid = true;
			return;
		}
		scan.id = record.id;
		scan.cwd = typeof record.cwd === "string" ? record.cwd : "";
		const created = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
		if (Number.isFinite(created)) scan.createdAt = created;
		return;
	}
	if (record.type === "session_info") {
		scan.name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : null;
		return;
	}
	if (record.type !== "message") return;
	scan.messageCount++;
	const message = record.message;
	if (!message || typeof message !== "object") return;
	noteMessage(scan, message as Record<string, unknown>, typeof record.timestamp === "string" ? record.timestamp : undefined);
}

function consumeLarge(scan: Scan, head: string): void {
	if (scan.invalid) return;
	if (!scan.id) {
		scan.invalid = true;
		return;
	}
	const type = /"type"\s*:\s*"([^"]+)"/.exec(head)?.[1];
	if (type === "session_info") {
		const name = readJsonString(head, /"name"\s*:\s*"/);
		scan.name = name?.trim() ? name.trim() : null;
		return;
	}
	if (type !== "message") return;
	scan.messageCount++;
	const role = /"message"\s*:\s*\{\s*"role"\s*:\s*"([^"]+)"/.exec(head)?.[1];
	if (role !== "user" && role !== "assistant") return;
	const stamped = /"timestamp"\s*:\s*"([^"]+)"/.exec(head)?.[1];
	const activity = stamped ? Date.parse(stamped) : NaN;
	if (Number.isFinite(activity)) scan.lastActivity = Math.max(scan.lastActivity, activity);
	if (role === "user" && !scan.firstMessage) {
		const text = readJsonString(head, /"content"\s*:\s*"/) || readJsonString(head, /"text"\s*:\s*"/);
		if (text?.trim()) scan.firstMessage = text.slice(0, TEXT_KEEP);
	}
}

function noteMessage(scan: Scan, message: Record<string, unknown>, entryTimestamp: string | undefined): void {
	const role = message.role;
	if (role !== "user" && role !== "assistant") return;
	const stamped = typeof message.timestamp === "number" ? message.timestamp : entryTimestamp ? Date.parse(entryTimestamp) : NaN;
	if (Number.isFinite(stamped)) scan.lastActivity = Math.max(scan.lastActivity, stamped);
	if (role === "user" && !scan.firstMessage) {
		const text = textOf(message.content);
		if (text.trim()) scan.firstMessage = text.slice(0, TEXT_KEEP);
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } =>
			!!block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join(" ");
}

/** A JSON string that starts where `pattern` (ending on the opening quote) matched. */
function readJsonString(source: string, pattern: RegExp): string | undefined {
	const match = pattern.exec(source);
	if (!match) return undefined;
	let cursor = match.index + match[0].length;
	let raw = "";
	const end = Math.min(source.length, cursor + TEXT_KEEP + 32);
	while (cursor < end) {
		const char = source[cursor];
		if (char === "\\") {
			if (cursor + 1 >= source.length) break;
			raw += char + source[cursor + 1];
			cursor += 2;
			continue;
		}
		if (char === "\"") break;
		raw += char;
		cursor++;
	}
	raw = raw.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
	try {
		const text = JSON.parse(`"${raw}"`) as unknown;
		return typeof text === "string" ? text : undefined;
	} catch {
		return undefined;
	}
}

function toSummary(path: string, entry: IndexEntry): SessionSummary {
	const first = entry.firstMessage || "(no messages)";
	const named = entry.name?.trim();
	return {
		id: entry.id,
		sessionFile: path,
		cwd: entry.cwd,
		titlePending: false,
		title: sessionTitle(named, first),
		preview: named ? normalizeLine(first, 160) : "",
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		messageCount: entry.messageCount,
	};
}

function isIndexEntry(value: IndexEntry | undefined): value is IndexEntry {
	return !!value
		&& typeof value.size === "number"
		&& typeof value.mtimeMs === "number"
		&& typeof value.id === "string"
		&& typeof value.cwd === "string"
		&& (value.name === null || typeof value.name === "string")
		&& typeof value.firstMessage === "string"
		&& typeof value.createdAt === "number"
		&& typeof value.updatedAt === "number"
		&& typeof value.messageCount === "number";
}

function sameDirectory(left: string, right: string): boolean {
	if (!left) return false;
	const a = resolve(left);
	const b = resolve(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function readIndex(directory: string): Promise<IndexFile> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(directory, INDEX_NAME), "utf8"));
		if (!parsed || typeof parsed !== "object") return { version: INDEX_VERSION, files: {} };
		const file = parsed as IndexFile;
		if (file.version !== INDEX_VERSION || !file.files || typeof file.files !== "object") return { version: INDEX_VERSION, files: {} };
		return file;
	} catch {
		return { version: INDEX_VERSION, files: {} };
	}
}

async function writeIndex(directory: string, index: IndexFile): Promise<void> {
	const path = join(directory, INDEX_NAME);
	const temporary = join(directory, `.${basename(INDEX_NAME)}.tmp`);
	try {
		await writeFile(temporary, JSON.stringify(index));
		await rename(temporary, path);
	} catch {
		// The list is already built; a missing index only means the next launch scans again.
	}
}

async function mapPool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor++;
			await run(items[index]!);
		}
	});
	await Promise.all(workers);
}
