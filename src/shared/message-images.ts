import type { PromptImageAttachment } from "./agent";

/** Preserve embedded images in both live messages and replayed history. */
export function messageImages(content: unknown): PromptImageAttachment[] {
	const blocks = Array.isArray(content) ? content : [content];
	return blocks.flatMap((block, index) => {
		if (!block || typeof block !== "object") return [];
		const { type, data, mimeType, name } = block;
		if (type !== "image" || typeof data !== "string" || !data ||
			typeof mimeType !== "string" || !/^image\/(png|jpeg|jpg|webp|gif|avif)$/i.test(mimeType)) return [];
		return [{ data, mimeType, name: typeof name === "string" ? name : `Image ${index + 1}` }];
	});
}
