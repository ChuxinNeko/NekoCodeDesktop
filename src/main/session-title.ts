import { normalizeLine } from "../shared/sessions";

/**
 * The model-written name for a session.
 *
 * A session used to be named after its opening prompt, which made the sidebar a
 * column of half-sentences. Instead the opening prompt goes to the session's own
 * model for a title, and the row shows a placeholder until that comes back —
 * so the request stays off the critical path of the run the user just started.
 *
 * The prompt building and the cleanup are here, apart from the service, because
 * they are what actually decides whether a row reads well.
 */

/** Sidebar rows are narrow; anything longer is clipped rather than wrapped. */
export const TITLE_MAX_LENGTH = 48;

/** A long opening prompt is usually pasted context — the first part is enough. */
const PROMPT_LIMIT = 4000;

/** Hard stop, so a hung request never leaves the row on the placeholder. */
export const TITLE_TIMEOUT_MS = 30_000;

/**
 * Generous for one line of output, because on a reasoning model this cap covers
 * the thinking too.
 *
 * Asking for thinking to be off is not portable: the Anthropic adapter reads a
 * missing `reasoning` option as "no thinking", while the OpenAI Responses one
 * reads it as "whatever the server defaults to" — and that default spends
 * hundreds of tokens before writing a word. A cap this size is free (only
 * generated tokens are billed) and the timeout still bounds the wait, whereas
 * a tight one would truncate the answer to nothing and silently fall back.
 */
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = [
	"You name conversations for a coding assistant's session list.",
	"Given the user's opening message, reply with a title that says what the conversation is about.",
	"Keep it under 6 words, or under 16 characters for Chinese, Japanese and Korean.",
	"Write the title in the same language as the message.",
	"Reply with the title alone: no quotes, no trailing period, no `Title:` prefix, no markdown, no explanation.",
].join("\n");

export interface TitleRequest {
	systemPrompt: string;
	messages: { role: "user"; content: string; timestamp: number }[];
	maxTokens: number;
}

/**
 * The one-shot completion that names a session, built from its opening prompt.
 *
 * `modelMaxTokens` is the model's own output cap: asking for more than a model
 * can produce is an error on strict providers, and small local models do have
 * caps under {@link MAX_TOKENS}.
 */
export function buildTitleRequest(
	firstPrompt: string,
	options: { modelMaxTokens?: number; now?: number } = {},
): TitleRequest {
	const cap = options.modelMaxTokens;
	return {
		systemPrompt: SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: firstPrompt.slice(0, PROMPT_LIMIT),
				timestamp: options.now ?? Date.now(),
			},
		],
		maxTokens: cap && cap > 0 ? Math.min(cap, MAX_TOKENS) : MAX_TOKENS,
	};
}

/**
 * Reduce a completion to a usable title, or `""` when it is not one.
 *
 * Models wrap titles in quotes, prefix them with "Title:", and occasionally
 * answer the prompt instead of naming it. The first three are worth cleaning up;
 * the last is why an over-long answer is rejected outright — falling back to the
 * opening prompt reads better than a paragraph clipped mid-word.
 */
export function sanitizeGeneratedTitle(raw: string): string {
	const firstLine = raw
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine || firstLine.length > 200) return "";
	const cleaned = firstLine
		.replace(/^(?:title|session title|标题|会话标题)\s*[:：]\s*/i, "")
		.replace(/^[#>*\-\s]+/, "")
		.replace(/^["'“”‘’`*_]+/, "")
		.replace(/["'“”‘’`*_]+$/, "")
		.replace(/[.。,，;；:：]+$/, "")
		.trim();
	return normalizeLine(cleaned, TITLE_MAX_LENGTH);
}
