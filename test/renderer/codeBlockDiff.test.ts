import { expect, test } from "bun:test";
import { codeBlockDiff } from "../../src/renderer/src/lib/codeBlockDiff";

test("parses hunk line numbers without counting file headers", () => {
 const rows = codeBlockDiff("--- a/file.ts\n+++ b/file.ts\n@@ -10,2 +10,3 @@\n same\n-old\n+new\n+extra\n@@ -30 +40 @@\n-before\n+after\n");
 expect(rows.map(row => [row.type,row.old,row.cur])).toEqual([["ctx",10,10],["del",11,null],["add",null,11],["add",null,12],["del",30,null],["add",null,40]]);
});
test("preserves source lines that resemble diff headers and empty added lines", () => {
 const rows = codeBlockDiff("@@ -1 +1,2 @@\n---source\n+++source\n+\n\\ No newline at end of file\n");
 expect(rows.map(row => row.pieces[0].text)).toEqual(["--source","++source",""]);
});
test("binary and empty patches do not fabricate example code", () => {
 expect(codeBlockDiff("")).toEqual([]);
 expect(codeBlockDiff("Binary files a/image.png and b/image.png differ")).toEqual([]);
});
