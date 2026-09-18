const MAX_ERROR_BYTES = 64 * 1024;
const SECRET_FIELD = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|authorization|proxy[_-]?authorization|cookie|set-cookie)$/i;

/** Preserve provider diagnostics while removing reflected credentials. */
export function redactAntigravityError(body: string, secrets: readonly string[] = []): string {
	const scrub = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(scrub);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SECRET_FIELD.test(key) ? "[REDACTED]" : scrub(entry)]));
		return value;
	};
	let text = body;
	try { text = JSON.stringify(scrub(JSON.parse(body)), null, 2); } catch { /* Plain text and HTML stay text. */ }
	for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
		for (const value of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) text = text.replaceAll(value, "[REDACTED]");
	}
	return text
		.replace(/\bBearer\s+[^\s"'<>\\]+/gi, "Bearer [REDACTED]")
		.replace(/((?:["']?)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s&,;}<>]+)/gi,
			(_match, prefix: string, value: string) => `${prefix}${value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]"}`);
}

export async function readAntigravityErrorBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "", bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) return text + decoder.decode();
			const remaining = MAX_ERROR_BYTES - bytes;
			text += decoder.decode(next.value.subarray(0, remaining), { stream: true });
			bytes += next.value.byteLength;
			if (bytes > MAX_ERROR_BYTES) return `${text}${decoder.decode()}\n[响应正文超过 64 KiB，已截断]`;
		}
	} catch {
		return `${text}${decoder.decode()}\n[读取上游错误正文失败]`;
	} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export function formatAntigravityError(summary: string, body: string, secrets: readonly string[] = []): string {
	const detail = redactAntigravityError(body, secrets).trim();
	return `${summary}\n\n上游错误正文：\n${detail || "（空响应正文）"}`;
}
