/**
 * `@` references in a prompt: a file, a folder, or a symbol in a file.
 *
 * The composer writes them into the text as plain tokens and main expands them
 * when the prompt is sent, so a reference typed by hand — or arriving from the
 * phone or QQ, which have no picker — works exactly like a picked one.
 */

export type MentionKind = "file" | "dir" | "symbol";

export interface MentionCandidate {
	kind: MentionKind;
	/** Project-relative, `/`-separated. Folders carry no trailing slash here. */
	path: string;
	/** The symbol's name; symbols only. */
	symbol?: string;
	/** 1-based declaration line; symbols only. */
	line?: number;
	/** What the symbol is declared as — `function`, `class` — shown beside it. */
	detail?: string;
}

/** A query that starts with this searches symbols instead of paths. */
export const SYMBOL_QUERY_PREFIX = "#";

/** Candidates per query. The menu shows a window of these. */
export const MAX_MENTION_RESULTS = 40;

/**
 * The trailer main appends to a prompt that referenced anything. The transcript
 * strips it back off, so the user sees what they typed and the model sees what
 * it pointed at.
 */
export const MENTION_BLOCK_OPEN = "<nekocode_mentions>";
export const MENTION_BLOCK_CLOSE = "</nekocode_mentions>";

/** The prompt as typed, with the expansion trailer (if any) removed. */
export function stripMentionBlock(text: string): string {
	const at = text.lastIndexOf(`\n\n${MENTION_BLOCK_OPEN}\n`);
	if (at < 0 || !text.trimEnd().endsWith(MENTION_BLOCK_CLOSE)) return text;
	return text.slice(0, at);
}

/** How a candidate is written into the prompt. */
export function mentionToken(candidate: MentionCandidate): string {
	const path = candidate.kind === "dir" ? `${candidate.path}/` : candidate.path;
	const body = candidate.kind === "symbol" && candidate.symbol ? `${path}#${candidate.symbol}` : path;
	return /[\s"]/.test(body) ? `@"${body.replace(/"/g, "")}"` : `@${body}`;
}

/**
 * Full-width punctuation ends a token even with no space before it: Chinese
 * text runs straight on after a path — "看看 @a.ts，然后…" — and a path never
 * contains these.
 */
const TOKEN_STOPS = "，。；：！？、）】「」『』《》";

export interface ParsedMention {
	/** The token as it appears in the text, `@` included. */
	raw: string;
	/** Path part, as typed — may end in `/`. */
	path: string;
	symbol?: string;
}

/**
 * Every `@token` in a prompt.
 *
 * Only an `@` at the start or after whitespace counts, so an address like
 * `me@example.com` is left alone. Whether a token names anything is main's
 * question — it only expands the ones that resolve inside the project, so a
 * decorator or an npm scope that happens to look like a path costs nothing.
 */
export function parseMentions(text: string): ParsedMention[] {
	const found: ParsedMention[] = [];
	const seen = new Set<string>();
	const pattern = new RegExp(`(^|\\s)@(?:"([^"\\n]+)"|([^\\s"${TOKEN_STOPS}]+))`, "g");
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		let body = match[2] ?? match[3] ?? "";
		// Trailing punctuation belongs to the sentence, not the path: "see @a.ts."
		if (match[3]) body = body.replace(/[.,;:!?)\]}，。；：！？）】]+$/, "");
		if (!body) continue;
		const hash = body.lastIndexOf("#");
		const path = hash > 0 ? body.slice(0, hash) : body;
		const symbol = hash > 0 ? body.slice(hash + 1) || undefined : undefined;
		const key = `${path}#${symbol ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		found.push({ raw: `@${match[2] !== undefined ? `"${body}"` : body}`, path, ...(symbol ? { symbol } : {}) });
	}
	return found;
}

/**
 * The `@query` being typed at the caret, or null when the caret is not in one.
 * `start` is the index of the `@`, so a pick can replace exactly that span.
 */
export function activeMention(text: string, caret: number): { start: number; query: string } | null {
	const before = text.slice(0, caret);
	const match = new RegExp(`(^|\\s)@([^\\s@"${TOKEN_STOPS}]*)$`).exec(before);
	if (!match) return null;
	return { start: caret - match[2].length - 1, query: match[2] };
}
