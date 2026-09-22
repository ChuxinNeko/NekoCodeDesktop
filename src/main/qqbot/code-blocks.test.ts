import { describe, expect, test } from "bun:test";
import { extractRenderables, parseTable } from "./code-blocks";

const CODE = ["```ts", "const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "```"].join("\n");

describe("extractRenderables", () => {
	test("lifts a fenced block out and leaves a marker in its place", () => {
		const { text, blocks } = extractRenderables(`改好了：\n\n${CODE}\n\n就这些。`);

		expect(text).toBe("改好了：\n\n［代码 1 · ts］\n\n就这些。");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ kind: "code", lang: "ts" });
		expect(blocks[0].content).toBe("const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;");
	});

	test("leaves a short block alone", () => {
		// A one-line `npm install` reads fine as text, and an image of it is
		// something you cannot copy out.
		const short = "```sh\nbun install\n```";
		const { text, blocks } = extractRenderables(`跑一下：\n\n${short}`);

		expect(blocks).toEqual([]);
		expect(text).toContain("bun install");
	});

	test("takes the language off an info string that carries more than one", () => {
		const input = '```ts title="a.ts"\n1\n2\n3\n4\n```';
		expect(extractRenderables(input).blocks[0].lang).toBe("ts");
	});

	test("handles a block with no language", () => {
		const { blocks } = extractRenderables("```\n1\n2\n3\n4\n```");

		expect(blocks[0].lang).toBeUndefined();
		expect(blocks[0].marker).toBe("［代码 1］");
	});

	test("lifts a table out", () => {
		const table = "| 文件 | 行数 |\n| --- | --- |\n| a.ts | 10 |\n| b.ts | 20 |";
		const { text, blocks } = extractRenderables(`统计：\n\n${table}\n\n完。`);

		expect(text).toBe("统计：\n\n［表格 1］\n\n完。");
		expect(blocks[0].kind).toBe("table");
	});

	test("leaves a header-only table alone", () => {
		const table = "| 文件 | 行数 |\n| --- | --- |";
		expect(extractRenderables(table).blocks).toEqual([]);
	});

	test("numbers code and tables in one sequence", () => {
		const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
		const { blocks } = extractRenderables(`${CODE}\n\n${table}`);

		expect(blocks.map((block) => block.marker)).toEqual(["［代码 1 · ts］", "［表格 2］"]);
	});

	test("stops after the cap and leaves the rest as text", () => {
		const { text, blocks } = extractRenderables([CODE, CODE, CODE].join("\n\n"), { max: 2 });

		expect(blocks).toHaveLength(2);
		// The third is still readable, just unformatted.
		expect(text).toContain("```ts");
	});

	test("an answer with nothing to draw comes back unchanged", () => {
		const prose = "改好了 LoginPage.tsx，没有别的。";
		expect(extractRenderables(prose)).toEqual({ text: prose, blocks: [] });
	});

	test("an unterminated fence is not mistaken for a block", () => {
		const input = "在改：\n```ts\nconst a = 1;";
		expect(extractRenderables(input).blocks).toEqual([]);
	});
});

describe("parseTable", () => {
	test("splits cells and drops the separator row", () => {
		expect(parseTable("| 文件 | 行数 |\n| --- | --- |\n| a.ts | 10 |")).toEqual([
			["文件", "行数"],
			["a.ts", "10"],
		]);
	});

	test("tolerates rows without outer pipes", () => {
		expect(parseTable("a | b\n--- | ---\n1 | 2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});
});
