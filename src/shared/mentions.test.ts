import { describe, expect, test } from "bun:test";
import {
	activeMention,
	MENTION_BLOCK_CLOSE,
	MENTION_BLOCK_OPEN,
	mentionToken,
	parseMentions,
	stripMentionBlock,
} from "./mentions";

describe("parseMentions", () => {
	test("finds files, folders and symbols", () => {
		expect(parseMentions("look at @src/a.ts and @src/ then @src/b.ts#run")).toEqual([
			{ raw: "@src/a.ts", path: "src/a.ts" },
			{ raw: "@src/", path: "src/" },
			{ raw: "@src/b.ts#run", path: "src/b.ts", symbol: "run" },
		]);
	});

	test("leaves email addresses alone", () => {
		expect(parseMentions("mail me@example.com")).toEqual([]);
	});

	test("drops sentence punctuation and duplicates", () => {
		expect(parseMentions("fix @a.ts. Then @a.ts，再看 @b.ts）").map((m) => m.path)).toEqual(["a.ts", "b.ts"]);
	});

	test("quoted paths may hold spaces", () => {
		expect(parseMentions('see @"docs/my notes.md"')).toEqual([{ raw: '@"docs/my notes.md"', path: "docs/my notes.md" }]);
	});

	test("a mention at the very start counts", () => {
		expect(parseMentions("@README.md summarize").map((m) => m.path)).toEqual(["README.md"]);
	});
});

describe("activeMention", () => {
	test("reports the @query at the caret", () => {
		const text = "open @src/ma";
		expect(activeMention(text, text.length)).toEqual({ start: 5, query: "src/ma" });
	});

	test("an empty query right after @ is still active", () => {
		expect(activeMention("hi @", 4)).toEqual({ start: 3, query: "" });
	});

	test("nothing once whitespace follows, or mid-word", () => {
		expect(activeMention("open @src ", 10)).toBeNull();
		expect(activeMention("me@exa", 6)).toBeNull();
	});
});

describe("mentionToken", () => {
	test("writes each kind so parseMentions reads it back", () => {
		const tokens = [
			mentionToken({ kind: "file", path: "src/a.ts" }),
			mentionToken({ kind: "dir", path: "src" }),
			mentionToken({ kind: "symbol", path: "src/a.ts", symbol: "run", line: 3 }),
			mentionToken({ kind: "file", path: "my docs/x.md" }),
		];
		expect(tokens).toEqual(["@src/a.ts", "@src/", "@src/a.ts#run", '@"my docs/x.md"']);
		expect(parseMentions(tokens.join(" ")).map((m) => [m.path, m.symbol])).toEqual([
			["src/a.ts", undefined],
			["src/", undefined],
			["src/a.ts", "run"],
			["my docs/x.md", undefined],
		]);
	});
});

describe("stripMentionBlock", () => {
	test("removes the trailer and nothing else", () => {
		const typed = "explain @a.ts";
		const sent = `${typed}\n\n${MENTION_BLOCK_OPEN}\nstuff\n${MENTION_BLOCK_CLOSE}`;
		expect(stripMentionBlock(sent)).toBe(typed);
		expect(stripMentionBlock(typed)).toBe(typed);
	});
});
