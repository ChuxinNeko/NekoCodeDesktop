const OPEN = "\n\n<!-- nekocode:interactive-context -->\n";
const CLOSE = "\n<!-- /nekocode:interactive-context -->";

/** Keep the requested words first; preserve interaction data in model history. */
export function interactiveMessage(message: string, params?: Record<string, unknown>, formState?: Record<string, unknown>): string {
	return message + OPEN + JSON.stringify({ version: 1, params: params ?? {}, formState: formState ?? {} }, null, 2) + CLOSE;
}

/** Project a stored interaction back to the ordinary user message it represents. */
export function displayInteractiveMessage(text: string): string | null {
	const at = text.lastIndexOf(OPEN);
	if (at >= 0 && text.endsWith(CLOSE)) {
		try {
			const data = JSON.parse(text.slice(at + OPEN.length, -CLOSE.length));
			if (data?.version === 1 && isRecord(data.params) && isRecord(data.formState)) return text.slice(0, at);
		} catch { /* Malformed blocks remain visible instead of hiding user text. */ }
	}
	// Existing saved turns used these localized labels without an envelope.
	const legacy = text.match(/^(?:来自交互式回复的用户操作：|User action from an interactive response: )([\s\S]*)$/);
	if (!legacy) return null;
	const sections = legacy[1].split(/\n(?:操作上下文：|提交的表单值：|Action context:|Submitted form values:)\n/);
	try {
		if (sections.slice(1).some(section => !isRecord(JSON.parse(section)))) return null;
		return sections[0];
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
