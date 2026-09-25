import { execFile } from "node:child_process";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	MAX_MENTION_RESULTS,
	MENTION_BLOCK_CLOSE,
	MENTION_BLOCK_OPEN,
	parseMentions,
	SYMBOL_QUERY_PREFIX,
	type MentionCandidate,
} from "../shared/mentions";
import { containsPath } from "./workflow-paths";

const runFile = promisify(execFile);

/** Files listed per project. A picker over more than this is a search box. */
const MAX_FILES = 50_000;
/** How long a listing is trusted. Long enough for a burst of keystrokes. */
const LIST_TTL_MS = 15_000;
const SYMBOL_TTL_MS = 60_000;
/** Files scanned for symbols, and the largest one worth scanning. */
const MAX_SYMBOL_FILES = 6_000;
const MAX_SYMBOL_FILE_BYTES = 400 * 1024;

/** One referenced file's share of the prompt, and all of them together. */
const MAX_FILE_BYTES = 60 * 1024;
const MAX_TOTAL_BYTES = 160 * 1024;
const MAX_DIR_ENTRIES = 300;
const MAX_SYMBOL_LINES = 150;

/** Skipped when walking a directory that is not a git repository. */
const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	".next",
	".nuxt",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	".turbo",
	".idea",
	".vs",
	"coverage",
]);

const toSlash = (path: string) => path.split(sep).join("/");

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const listings = new Map<string, { at: number; files: Promise<string[]> }>();

/**
 * Every file under `cwd`, project-relative and `/`-separated.
 *
 * Git's own view when there is one — it already knows what is ignored, and it
 * answers in milliseconds where a walk of `node_modules` would take seconds.
 */
export function listProjectFiles(cwd: string): Promise<string[]> {
	const key = resolve(cwd);
	const cached = listings.get(key);
	if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.files;
	const files = gitFiles(key)
		.catch(() => walk(key))
		.then((list) => list.slice(0, MAX_FILES));
	listings.set(key, { at: Date.now(), files });
	files.catch(() => listings.delete(key));
	return files;
}

async function gitFiles(cwd: string): Promise<string[]> {
	const { stdout } = await runFile("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd,
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	});
	return [...new Set(stdout.split("\0").filter(Boolean))];
}

async function walk(root: string): Promise<string[]> {
	const files: string[] = [];
	const queue: string[] = [""];
	while (queue.length && files.length < MAX_FILES) {
		const dir = queue.shift()!;
		let entries;
		try {
			entries = await readdir(resolve(root, dir), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) queue.push(rel);
			} else if (entry.isFile()) files.push(rel);
		}
	}
	return files;
}

function directoriesOf(files: readonly string[]): string[] {
	const dirs = new Set<string>();
	for (const file of files) {
		for (let at = file.indexOf("/"); at > 0; at = file.indexOf("/", at + 1)) dirs.add(file.slice(0, at));
	}
	return [...dirs];
}

// ---------------------------------------------------------------------------
// Path search
// ---------------------------------------------------------------------------

/** Lower is better; -1 is no match. */
export function scorePath(path: string, query: string): number {
	const q = query.toLowerCase();
	const lower = path.toLowerCase();
	const name = lower.slice(lower.lastIndexOf("/") + 1);
	if (name === q) return 0;
	if (name.startsWith(q)) return 1;
	if (name.includes(q)) return 2;
	if (lower.includes(q)) return 3;
	// Subsequence: `wfrt` finds `workflow-runtime.ts`.
	let from = 0;
	for (const char of q) {
		from = lower.indexOf(char, from);
		if (from < 0) return -1;
		from++;
	}
	return 4;
}

export function rankPaths(files: readonly string[], query: string, limit = MAX_MENTION_RESULTS): MentionCandidate[] {
	const dirs = directoriesOf(files);
	const q = query.trim();
	if (!q) {
		// Nothing typed yet: the top of the tree, folders first.
		const top = [
			...dirs.filter((dir) => !dir.includes("/")).sort().map((path) => ({ kind: "dir" as const, path })),
			...files.filter((file) => !file.includes("/")).sort().map((path) => ({ kind: "file" as const, path })),
		];
		return top.slice(0, limit);
	}
	const scored: Array<{ candidate: MentionCandidate; score: number }> = [];
	for (const path of files) {
		const score = scorePath(path, q);
		if (score >= 0) scored.push({ candidate: { kind: "file", path }, score });
	}
	for (const path of dirs) {
		const score = scorePath(path, q);
		if (score >= 0) scored.push({ candidate: { kind: "dir", path }, score });
	}
	return scored
		.sort((a, b) => a.score - b.score || a.candidate.path.length - b.candidate.path.length || a.candidate.path.localeCompare(b.candidate.path))
		.slice(0, limit)
		.map((entry) => entry.candidate);
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export interface SymbolEntry {
	name: string;
	path: string;
	line: number;
	detail: string;
}

type Matcher = RegExp;

const JS: Matcher[] = [
	/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
	/^(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)/,
];
const PY: Matcher[] = [/^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/];
const GO: Matcher[] = [/^(func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^(type)\s+([A-Za-z_]\w*)/];
const RUST: Matcher[] = [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn|struct|enum|trait|type|mod|const|static|impl)\s+([A-Za-z_]\w*)/];
const CLASSY: Matcher[] = [
	/^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|data|open|export)\s+)*(class|interface|enum|record|object|struct|trait)\s+([A-Za-z_]\w*)/,
	/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|suspend)\s+)+(?:fun\s+|[\w<>[\],.?]+\s+)([A-Za-z_]\w*)\s*\(/,
];

const MATCHERS: Record<string, Matcher[]> = {
	".ts": JS, ".tsx": JS, ".js": JS, ".jsx": JS, ".mjs": JS, ".cjs": JS, ".mts": JS, ".cts": JS, ".vue": JS, ".svelte": JS,
	".py": PY,
	".go": GO,
	".rs": RUST,
	".java": CLASSY, ".kt": CLASSY, ".kts": CLASSY, ".cs": CLASSY, ".swift": CLASSY, ".scala": CLASSY, ".dart": CLASSY,
	".c": CLASSY, ".h": CLASSY, ".cpp": CLASSY, ".hpp": CLASSY, ".cc": CLASSY,
};

/** The declarations in one file's text. Exported for tests. */
export function extractSymbols(path: string, text: string): SymbolEntry[] {
	const matchers = MATCHERS[extname(path).toLowerCase()];
	if (!matchers) return [];
	const symbols: SymbolEntry[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.length > 400) continue;
		for (const matcher of matchers) {
			const match = matcher.exec(line);
			if (!match) continue;
			// Two-group patterns name the keyword first; the method pattern has only the name.
			const name = match[2] ?? match[1];
			const detail = match[2] ? match[1] : "method";
			if (name) symbols.push({ name, path, line: i + 1, detail });
			break;
		}
	}
	return symbols;
}

const symbolIndexes = new Map<string, { at: number; symbols: Promise<SymbolEntry[]> }>();

async function symbolIndex(cwd: string): Promise<SymbolEntry[]> {
	const key = resolve(cwd);
	const cached = symbolIndexes.get(key);
	if (cached && Date.now() - cached.at < SYMBOL_TTL_MS) return cached.symbols;
	const symbols = (async () => {
		const files = (await listProjectFiles(key)).filter((file) => MATCHERS[extname(file).toLowerCase()]).slice(0, MAX_SYMBOL_FILES);
		const found: SymbolEntry[] = [];
		// A few at a time: enough to hide the latency, not so many that a large
		// repository exhausts file handles.
		for (let i = 0; i < files.length; i += 32) {
			const batch = await Promise.all(
				files.slice(i, i + 32).map(async (file) => {
					try {
						const target = resolve(key, file);
						if ((await stat(target)).size > MAX_SYMBOL_FILE_BYTES) return [];
						return extractSymbols(file, await readFile(target, "utf8"));
					} catch {
						return [];
					}
				}),
			);
			for (const list of batch) found.push(...list);
		}
		return found;
	})();
	symbolIndexes.set(key, { at: Date.now(), symbols });
	symbols.catch(() => symbolIndexes.delete(key));
	return symbols;
}

export function rankSymbols(symbols: readonly SymbolEntry[], query: string, limit = MAX_MENTION_RESULTS): MentionCandidate[] {
	const q = query.trim().toLowerCase();
	const scored: Array<{ entry: SymbolEntry; score: number }> = [];
	for (const entry of symbols) {
		const name = entry.name.toLowerCase();
		const score = !q ? 2 : name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : -1;
		if (score >= 0) scored.push({ entry, score });
	}
	return scored
		.sort((a, b) => a.score - b.score || a.entry.name.length - b.entry.name.length || a.entry.path.localeCompare(b.entry.path))
		.slice(0, limit)
		.map(({ entry }) => ({ kind: "symbol", path: entry.path, symbol: entry.name, line: entry.line, detail: entry.detail }));
}

/** What the `@` picker offers for `query` in `cwd`. */
export async function searchMentions(cwd: string, query: string): Promise<MentionCandidate[]> {
	if (!cwd) return [];
	if (query.startsWith(SYMBOL_QUERY_PREFIX)) {
		const q = query.slice(SYMBOL_QUERY_PREFIX.length);
		// Every declaration in the project is not a useful list.
		if (!q.trim()) return [];
		return rankSymbols(await symbolIndex(cwd), q);
	}
	return rankPaths(await listProjectFiles(cwd), query);
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/** Resolve a typed path inside the project, or null for anything outside it. */
function inside(cwd: string, typed: string): string | null {
	const root = resolve(cwd);
	const target = resolve(root, typed.replace(/[\\/]+$/, "") || ".");
	return containsPath(root, target) ? target : null;
}

async function readHead(path: string, limit: number): Promise<{ text: string; truncated: boolean; binary: boolean }> {
	const file = await open(path, "r");
	try {
		const size = (await file.stat()).size;
		const buffer = Buffer.alloc(Math.min(size, limit));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const head = buffer.subarray(0, bytesRead);
		if (head.subarray(0, 8192).includes(0)) return { text: "", truncated: false, binary: true };
		return { text: head.toString("utf8"), truncated: size > limit, binary: false };
	} finally {
		await file.close();
	}
}

/** The declaration of `name` in `text`, with its body, as numbered lines. */
export function symbolSnippet(path: string, text: string, name: string): { start: number; end: number; body: string } | null {
	const lines = text.split("\n");
	const declared = extractSymbols(path, text).find((entry) => entry.name === name);
	let start = declared ? declared.line - 1 : -1;
	if (start < 0) {
		const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
		start = lines.findIndex((line) => word.test(line));
	}
	if (start < 0) return null;
	const indentOf = (line: string) => /^\s*/.exec(line)![0].length;
	const baseIndent = indentOf(lines[start]);
	const python = extname(path).toLowerCase() === ".py";
	let end = start;
	let depth = 0;
	let opened = false;
	for (let i = start; i < lines.length && i - start < MAX_SYMBOL_LINES; i++) {
		end = i;
		const line = lines[i];
		if (python) {
			if (i > start && line.trim() && indentOf(line) <= baseIndent) {
				end = i - 1;
				break;
			}
			continue;
		}
		for (const char of line) {
			if (char === "{") {
				depth++;
				opened = true;
			} else if (char === "}") depth--;
		}
		// A one-line declaration (`type A = B;`) ends where it started.
		if (opened ? depth <= 0 : i === start && /;\s*$/.test(line)) break;
	}
	while (end > start && !lines[end].trim()) end--;
	const width = String(end + 1).length;
	const body = lines
		.slice(start, end + 1)
		.map((line, index) => `${String(start + index + 1).padStart(width)}  ${line}`)
		.join("\n");
	return { start: start + 1, end: end + 1, body };
}

/**
 * Attach what a prompt's `@` references point at.
 *
 * Returns the prompt unchanged when nothing resolves. Otherwise the contents
 * ride along in a trailer the transcript strips back off, so the conversation
 * shows the prompt as written. Each reference is read now, from disk — which is
 * the point: the model sees the file as it is, not as it was remembered.
 */
export async function expandMentions(cwd: string, text: string): Promise<string> {
	const mentions = parseMentions(text);
	if (mentions.length === 0) return text;
	const root = resolve(cwd);
	const parts: string[] = [];
	let budget = MAX_TOTAL_BYTES;
	let files: string[] | null = null;

	for (const mention of mentions) {
		const target = inside(root, mention.path);
		if (!target) continue;
		let info;
		try {
			info = await stat(target);
		} catch {
			continue;
		}
		const rel = toSlash(relative(root, target)) || ".";

		if (info.isDirectory()) {
			files ??= await listProjectFiles(root).catch(() => []);
			const prefix = rel === "." ? "" : `${rel}/`;
			let entries = files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
			if (entries.length === 0) {
				// Ignored by git, or empty: say what is directly in it.
				entries = (await readdir(target, { withFileTypes: true }).catch(() => []))
					.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
			}
			const shown = entries.slice(0, MAX_DIR_ENTRIES);
			const listing = shown.join("\n") + (entries.length > shown.length ? `\n…（另有 ${entries.length - shown.length} 项）` : "");
			if (listing.length > budget) {
				parts.push(`<directory path="${rel}/" omitted="true">内容过多未附上，请用 ls/find 查看。</directory>`);
				continue;
			}
			budget -= listing.length;
			parts.push(`<directory path="${rel}/" entries="${entries.length}">\n${listing}\n</directory>`);
			continue;
		}
		if (!info.isFile()) continue;

		if (mention.symbol) {
			try {
				const { text: source, binary } = await readHead(target, MAX_SYMBOL_FILE_BYTES);
				const snippet = binary ? null : symbolSnippet(rel, source, mention.symbol);
				if (snippet && snippet.body.length <= budget) {
					budget -= snippet.body.length;
					parts.push(`<symbol name="${mention.symbol}" path="${rel}" lines="${snippet.start}-${snippet.end}">\n${snippet.body}\n</symbol>`);
					continue;
				}
			} catch {
				// Fall through to attaching the file.
			}
		}

		if (budget <= 0) {
			parts.push(`<file path="${rel}" omitted="true">篇幅已满未附上，请用 read 读取。</file>`);
			continue;
		}
		try {
			const head = await readHead(target, Math.min(MAX_FILE_BYTES, budget));
			if (head.binary) {
				parts.push(`<file path="${rel}" binary="true" bytes="${info.size}"></file>`);
				continue;
			}
			budget -= head.text.length;
			parts.push(
				`<file path="${rel}" bytes="${info.size}"${head.truncated ? ' truncated="true"' : ""}>\n${head.text}${head.truncated ? "\n…（已截断，其余部分请用 read 读取）" : ""}\n</file>`,
			);
		} catch {
			// Unreadable: the model can still try the path itself.
		}
	}
	if (parts.length === 0) return text;
	return [
		text,
		"",
		MENTION_BLOCK_OPEN,
		"用户用 @ 引用了以下内容（发送时从磁盘读取的当前版本）：",
		"",
		parts.join("\n\n"),
		MENTION_BLOCK_CLOSE,
	].join("\n");
}
