import { highlightFileToHtml } from "./codeHighlight";

self.onmessage = async ({ data }: MessageEvent<{ id: number; code: string; filename: string }>) => {
	try {
		const html = await highlightFileToHtml(data.code, data.filename);
		self.postMessage({ id: data.id, html });
	} catch {
		// Plain text remains a fully usable preview when a grammar fails.
		self.postMessage({ id: data.id, html: null });
	}
};
