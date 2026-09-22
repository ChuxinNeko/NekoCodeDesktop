import { describe, expect, test } from "bun:test";
import { flattenMarkdown, flattenUnsupported } from "./markdown";

describe("flattenUnsupported", () => {
	test("keeps what QQ draws", () => {
		const input = "## 结果\n\n- **粗体** 和 *斜体*\n- [文档](https://example.com)\n\n> 注意";
		// 自定义 Markdown covers all of these, so none of it should be touched.
		expect(flattenUnsupported(input)).toBe(input);
	});

	test("takes off what QQ does not draw", () => {
		const input = "改好了 `LoginPage.tsx`：\n\n```ts\nconst a = 1;\n```";
		expect(flattenUnsupported(input)).toBe("改好了 LoginPage.tsx：\n\nconst a = 1;");
	});

	test("drops a table's separator row but keeps the rows", () => {
		const input = "| 文件 | 行数 |\n| --- | --- |\n| a.ts | 10 |";
		expect(flattenUnsupported(input)).toBe("| 文件 | 行数 |\n| a.ts | 10 |");
	});

	test("survives an unterminated fence", () => {
		expect(flattenUnsupported("在改了：\n```ts\nconst a = 1;")).toBe("在改了：\nconst a = 1;");
	});
});

describe("flattenMarkdown", () => {
	test("flattens the shape a coding agent actually answers in", () => {
		const answer = [
			"当前目录 `D:/work/mihomo` 下有:",
			"",
			"- **`.tmp-recon/`** — 目录（临时侦察产物）",
			"- **`bicycle-rides.html`** — 单个 HTML 文件",
			"",
			"需要我进一步展开某个目录吗？",
		].join("\n");

		expect(flattenMarkdown(answer)).toBe(
			[
				"当前目录 D:/work/mihomo 下有:",
				"",
				"· .tmp-recon/ — 目录（临时侦察产物）",
				"· bicycle-rides.html — 单个 HTML 文件",
				"",
				"需要我进一步展开某个目录吗？",
			].join("\n"),
		);
	});

	test("keeps a code block's contents and drops its fence", () => {
		const input = "改好了：\n\n```ts\nconst a = 1;\n```\n\n就这些。";
		expect(flattenMarkdown(input)).toBe("改好了：\n\nconst a = 1;\n\n就这些。");
	});

	test("leaves markup inside a code block alone", () => {
		// The fence is lifted out before the inline rules run, so this survives.
		const input = "```\nconst bold = '**not emphasis**';\n```";
		expect(flattenMarkdown(input)).toBe("const bold = '**not emphasis**';");
	});

	test("does not eat underscores in identifiers", () => {
		expect(flattenMarkdown("改了 file_name_here 和 __init__ 两个地方")).toBe(
			"改了 file_name_here 和 __init__ 两个地方",
		);
	});

	test("strips heading hashes and blockquote markers", () => {
		expect(flattenMarkdown("## 结果\n\n> 注意这里")).toBe("结果\n\n注意这里");
	});

	test("keeps a link's URL", () => {
		expect(flattenMarkdown("见 [文档](https://example.com/a)")).toBe("见 文档 (https://example.com/a)");
		expect(flattenMarkdown("[https://example.com](https://example.com)")).toBe("https://example.com");
	});

	test("drops an image reference, which is sent as a file instead", () => {
		expect(flattenMarkdown("截图：\n\n![](out.png)\n\n好了")).toBe("截图：\n\n好了");
		expect(flattenMarkdown("![登录页](out.png)")).toBe("[图片：登录页]");
	});

	test("drops a table's separator row", () => {
		const table = "| 文件 | 行数 |\n| --- | --- |\n| a.ts | 10 |";
		expect(flattenMarkdown(table)).toBe("| 文件 | 行数 |\n| a.ts | 10 |");
	});

	test("survives an unterminated fence from a truncated answer", () => {
		expect(flattenMarkdown("在改了：\n```ts\nconst a = 1;")).toBe("在改了：\nconst a = 1;");
	});

	test("nested bullets keep their indentation", () => {
		expect(flattenMarkdown("- 一\n  - 二")).toBe("· 一\n  · 二");
	});

	test("numbered lists are left alone", () => {
		expect(flattenMarkdown("1. 第一步\n2. 第二步")).toBe("1. 第一步\n2. 第二步");
	});

	test("emphasis around whole words comes off", () => {
		expect(flattenMarkdown("这是 *斜体* 和 **粗体** 和 ~~删除~~")).toBe("这是 斜体 和 粗体 和 删除");
	});

	test("a multiplication-looking asterisk is not treated as emphasis", () => {
		expect(flattenMarkdown("2 * 3 * 4")).toBe("2 * 3 * 4");
	});
});
