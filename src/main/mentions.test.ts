import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MENTION_BLOCK_OPEN, stripMentionBlock } from "../shared/mentions";
import { expandMentions, extractSymbols, rankPaths, rankSymbols, scorePath, searchMentions, symbolSnippet } from "./mentions";

const root = mkdtempSync(join(tmpdir(), "nekocode-mentions-"));
mkdirSync(join(root, "src", "lib"), { recursive: true });
mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
writeFileSync(join(root, "README.md"), "# Demo\n");
writeFileSync(
	join(root, "src", "workflow-runtime.ts"),
	[
		"import x from 'y';",
		"",
		"export function startRun(a: number) {",
		"\tif (a) {",
		"\t\treturn 1;",
		"\t}",
		"\treturn 2;",
		"}",
		"",
		"export type Mode = 'a' | 'b';",
	].join("\n"),
);
writeFileSync(join(root, "src", "lib", "util.py"), "def helper(x):\n    return x\n\nclass Thing:\n    pass\n");
writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("path ranking", () => {
	test("a name match beats a path match beats a subsequence", () => {
		expect(scorePath("src/workflow-runtime.ts", "workflow-runtime.ts")).toBe(0);
		expect(scorePath("src/workflow-runtime.ts", "work")).toBe(1);
		expect(scorePath("src/workflow-runtime.ts", "runtime")).toBe(2);
		expect(scorePath("src/workflow-runtime.ts", "src/w")).toBe(3);
		expect(scorePath("src/workflow-runtime.ts", "wfrt")).toBe(4);
		expect(scorePath("src/workflow-runtime.ts", "zzz")).toBe(-1);
	});

	test("folders are offered too, and an empty query lists the top level", () => {
		const files = ["README.md", "src/a.ts", "src/lib/b.ts"];
		expect(rankPaths(files, "lib")).toContainEqual({ kind: "dir", path: "src/lib" });
		expect(rankPaths(files, "")).toEqual([
			{ kind: "dir", path: "src" },
			{ kind: "file", path: "README.md" },
		]);
	});
});

describe("symbols", () => {
	test("declarations are found per language", () => {
		expect(extractSymbols("a.ts", "export async function go() {}\nconst x = 1;\n  const inner = 2;\nclass A {}").map((s) => [s.name, s.detail])).toEqual([
			["go", "function"],
			["x", "const"],
			["A", "class"],
		]);
		expect(extractSymbols("u.py", "def helper(x):\n    pass\nclass Thing:\n").map((s) => s.name)).toEqual(["helper", "Thing"]);
		expect(extractSymbols("notes.txt", "function nope() {}")).toEqual([]);
	});

	test("prefix matches rank first", () => {
		const symbols = [
			{ name: "restart", path: "a.ts", line: 1, detail: "function" },
			{ name: "startRun", path: "b.ts", line: 3, detail: "function" },
		];
		expect(rankSymbols(symbols, "start").map((c) => c.symbol)).toEqual(["startRun", "restart"]);
	});

	test("a snippet runs to the end of the braced body", () => {
		const text = "x\nfunction f() {\n  if (y) {\n    z();\n  }\n}\nafter();";
		const snippet = symbolSnippet("a.ts", text, "f");
		expect(snippet?.start).toBe(2);
		expect(snippet?.end).toBe(6);
		expect(snippet?.body).not.toContain("after");
	});

	test("a python snippet ends where the indentation does", () => {
		const snippet = symbolSnippet("u.py", "def helper(x):\n    return x\n\nclass Thing:\n    pass\n", "helper");
		expect(snippet?.end).toBe(2);
	});
});

describe("search and expansion", () => {
	test("search walks the project and skips node_modules", async () => {
		const found = await searchMentions(root, "index");
		expect(found.some((c) => c.path.includes("node_modules"))).toBe(false);
		const runtime = await searchMentions(root, "workflow");
		expect(runtime[0]).toEqual({ kind: "file", path: "src/workflow-runtime.ts" });
	});

	test("symbol search needs a # query", async () => {
		expect(await searchMentions(root, "#")).toEqual([]);
		const found = await searchMentions(root, "#startR");
		expect(found[0]).toMatchObject({ kind: "symbol", symbol: "startRun", path: "src/workflow-runtime.ts", line: 3 });
	});

	test("expansion attaches files, folders and symbols, and round-trips for display", async () => {
		const typed = "check @README.md and @src/ and @src/workflow-runtime.ts#startRun";
		const sent = await expandMentions(root, typed);
		expect(sent).toContain(MENTION_BLOCK_OPEN);
		expect(sent).toContain('<file path="README.md"');
		expect(sent).toContain("# Demo");
		expect(sent).toContain('<directory path="src/"');
		expect(sent).toContain("lib/util.py");
		expect(sent).toContain('<symbol name="startRun" path="src/workflow-runtime.ts" lines="3-8">');
		expect(sent).not.toContain("export type Mode");
		expect(stripMentionBlock(sent)).toBe(typed);
	});

	test("paths that do not exist or leave the project are left as text", async () => {
		const typed = "decorate with @Component and read @../../etc/passwd";
		expect(await expandMentions(root, typed)).toBe(typed);
	});
});
