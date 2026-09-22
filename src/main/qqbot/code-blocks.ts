/**
 * Pull out the parts of an answer that QQ cannot draw as text.
 *
 * Code fences and tables are the two things 自定义 Markdown has no syntax for,
 * and they are also the two that lose the most when flattened — indentation
 * collapses, columns stop lining up. Rendering them as pictures is the only way
 * a phone shows them the way the desktop does.
 *
 * Pure on purpose: the rasterizer needs Electron, and what to render is the
 * half worth pinning down in tests.
 */

/** A fenced block, with its info string. */
const FENCE = /^([ \t]*)```([^\n]*)\n([\s\S]*?)\n?\1```[ \t]*$/gm;
/** A table is a header row, a separator row, and at least one body row. */
const TABLE =
	/^[ \t]*\|.+\|[ \t]*\n[ \t]*\|?[\s:|-]*-{2,}[\s:|-]*\|?[ \t]*\n(?:[ \t]*\|.*\|[ \t]*\n?)+/gm;

export interface Renderable {
	kind: "code" | "table";
	/** Info string off the fence, when it named one. */
	lang?: string;
	/** The text to draw. For a table, the Markdown source. */
	content: string;
	/** What replaces it in the prose, so the sentence around it still reads. */
	marker: string;
}

export interface ExtractOptions {
	/**
	 * Shortest code block worth a picture.
	 *
	 * A one-line `npm install` reads perfectly well as text, and turning it into
	 * an image makes it uncopyable for no gain.
	 */
	minCodeLines?: number;
	/** Images per message. Past a few it is noise, and QQ rate-limits sends. */
	max?: number;
}

export function extractRenderables(
	markdown: string,
	options: ExtractOptions = {},
): { text: string; blocks: Renderable[] } {
	const minCodeLines = options.minCodeLines ?? 4;
	const max = options.max ?? 4;
	const blocks: Renderable[] = [];

	const take = (kind: Renderable["kind"], content: string, lang?: string): string | null => {
		if (blocks.length >= max) return null;
		const index = blocks.length + 1;
		const marker = kind === "code" ? `［代码 ${String(index)}${lang ? ` · ${lang}` : ""}］` : `［表格 ${String(index)}］`;
		blocks.push({ kind, content, marker, ...(lang ? { lang } : {}) });
		return marker;
	};

	let text = markdown.replace(FENCE, (match, _indent: string, info: string, code: string) => {
		if (code.split("\n").length < minCodeLines) return match;
		// The info string can carry more than a language (`ts title="x"`).
		const lang = info.trim().split(/\s+/)[0] || undefined;
		return take("code", code, lang) ?? match;
	});

	text = text.replace(TABLE, (match: string) => {
		const rows = match.trimEnd().split("\n").length;
		if (rows < 3) return match;
		return `${take("table", match.trimEnd()) ?? match}\n`;
	});

	return { text: text.replace(/\n{3,}/g, "\n\n").trim(), blocks };
}

/** A table's cells, header row first, for the renderer to lay out. */
export function parseTable(markdown: string): string[][] {
	return markdown
		.trim()
		.split("\n")
		.filter((line) => !/^[ \t]*\|?[\s:|-]*-{2,}[\s:|-]*\|?[ \t]*$/.test(line))
		.map((line) =>
			line
				.trim()
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((cell) => cell.trim()),
		);
}
