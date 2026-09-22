/**
 * Make Markdown readable in a QQ message.
 *
 * Two levels, because two things can be true of a transport:
 *
 * - {@link flattenMarkdown} takes everything off, for a plain-text transport —
 *   OneBot, or an official bot sending `msg_type=0`. Without it the user reads
 *   ``- **`.tmp-recon/`** — 目录`` literally.
 * - {@link flattenUnsupported} takes off only what QQ's own Markdown cannot
 *   draw. 自定义 Markdown covers headings, emphasis, lists, links, quotes and
 *   rules, and covers none of code fences, inline code or tables — which is
 *   most of what a coding agent writes.
 *
 * Flattened rather than stripped either way: the structure a model writes is
 * doing work. A bullet becomes a bullet, a link keeps its URL, and a fenced
 * block keeps its contents on their own lines.
 */

/** Fenced blocks are lifted out first so inline rules never touch code. */
const FENCE = /```[^\n]*\n?([\s\S]*?)```/g;
/** Consumes its newline too, or a truncated answer ends on a blank line. */
const STRAY_FENCE = /^[ \t]*```[^\n]*\n?/gm;

/**
 * Stand-in for a lifted code block.
 *
 * A private-use codepoint rather than anything typeable: the placeholder has to
 * be something the model's own output cannot plausibly contain, or an answer
 * that happens to mention it would get a code block pasted into the middle.
 */
const MARK = "\u{E000}";
const MARKED = /\u{E000}(\d+)\u{E000}/gu;

/** A table's separator row is pure markup wherever it lands. */
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/**
 * Take off only what QQ's Markdown cannot render.
 *
 * Code is the whole reason this exists: 自定义 Markdown draws no fences and no
 * inline code, so leaving them in shows the backticks. What comes out is plain
 * text sitting inside a Markdown message, which means a path like `__init__`
 * can end up drawn as bold — cosmetic, and far cheaper than the alternative of
 * guessing at an escape syntax the platform does not document.
 */
export function flattenUnsupported(input: string): string {
	const text = input
		.replaceAll(MARK, "")
		.replace(FENCE, (_match, code: string) => `\n${code.replace(/\n+$/, "")}\n`)
		.replace(STRAY_FENCE, "")
		.replace(/`([^`\n]+)`/g, "$1");
	return text
		.split("\n")
		.filter((line) => !TABLE_RULE.test(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function flattenMarkdown(input: string): string {
	const blocks: string[] = [];
	const stash = (code: string) => {
		blocks.push(code.replace(/\n+$/, ""));
		return `${MARK}${String(blocks.length - 1)}${MARK}`;
	};

	// Any mark already in the input would be indistinguishable from a placeholder.
	let text = input.replaceAll(MARK, "").replace(FENCE, (_match, code: string) => stash(code));
	// An unterminated fence — a truncated answer — leaves a stray marker line.
	text = text.replace(STRAY_FENCE, "");

	text = text
		// Images first: the file itself is sent alongside, so a second textual
		// reference to it is noise.
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => (alt.trim() ? `[图片：${alt.trim()}]` : ""))
		.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_match, label: string, url: string) =>
			label.trim() === url.trim() ? url : `${label} (${url})`,
		)
		// Inline code: the backticks carry no meaning once the font is the same.
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/\*\*\*([^*\n]+)\*\*\*/g, "$1")
		.replace(/\*\*([^*\n]+)\*\*/g, "$1")
		// The inner bound rejects a leading or trailing space, which is what keeps
		// `2 * 3 * 4` from reading as emphasis around " 3 ".
		.replace(/(^|[^\w*])\*([^*\s\n](?:[^*\n]*[^*\s\n])?)\*(?=[^\w*]|$)/g, "$1$2")
		.replace(/~~([^~\n]+)~~/g, "$1");

	text = text
		.split("\n")
		.map((line) => {
			// A table's separator row is pure markup and reads as line noise.
			if (TABLE_RULE.test(line)) return null;
			if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) return "————————";
			return line
				.replace(/^(\s*)#{1,6}\s+/, "$1")
				.replace(/^(\s*)>\s?/, "$1")
				// `- ` and `* ` become a bullet QQ draws the same everywhere. Numbered
				// lists are left alone: "1." already reads as a list.
				.replace(/^(\s*)[-*+]\s+/, "$1· ");
		})
		.filter((line): line is string => line !== null)
		.join("\n");

	// Underscore emphasis is deliberately left alone. `_x_` and `__x__` are rare
	// in a coding agent's prose and everywhere in its subject matter — stripping
	// them turns `__init__` into `init`, which is a wrong answer rather than an
	// unrendered one.

	text = text.replace(MARKED, (_match, index: string) => blocks[Number(index)] ?? "");
	// Blank-line runs left behind by removed images or rules.
	return text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trim();
}
