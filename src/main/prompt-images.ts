import type { ImageContent } from "@earendil-works/pi-ai";
import {
	MAX_PROMPT_IMAGE_BYTES,
	MAX_PROMPT_IMAGE_TOTAL_BYTES,
	MAX_PROMPT_IMAGES,
	type PromptImageAttachment,
} from "../shared/agent";

export interface PromptImageProcessResult {
	ok: boolean;
	data?: string;
	mimeType?: string;
	message?: string;
}

export type PromptImageProcessor = (
	bytes: Uint8Array,
	mimeType: string,
	options: { autoResizeImages: boolean },
) => Promise<PromptImageProcessResult>;

const ACCEPTED_MIME_TYPES: ReadonlyMap<string, string> = new Map([
	["image/png", "image/png"],
	["image/jpeg", "image/jpeg"],
	["image/jpg", "image/jpeg"],
	["image/webp", "image/webp"],
	["image/gif", "image/gif"],
	["image/bmp", "image/bmp"],
]);

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function normalizeMimeType(mimeType: unknown): string {
	if (typeof mimeType !== "string") {
		throw new Error("图片格式不受支持");
	}
	const normalized = ACCEPTED_MIME_TYPES.get(mimeType.trim().toLowerCase());
	if (!normalized) throw new Error("图片格式不受支持，仅支持 PNG、JPEG、WebP、GIF、BMP");
	return normalized;
}

function decodeData(data: unknown): Uint8Array {
	if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
		throw new Error("图片数据不是有效的 base64");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.length === 0) throw new Error("图片数据不是有效的 base64");
	if (bytes.length > MAX_PROMPT_IMAGE_BYTES) {
		throw new Error(`图片超过 ${String(MAX_PROMPT_IMAGE_BYTES / 1024 / 1024)} MiB 大小限制`);
	}
	return bytes;
}

function validateName(name: unknown): void {
	if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 255) {
		throw new Error("图片文件名无效");
	}
}

export async function preparePromptImages(
	attachments: PromptImageAttachment[] | undefined,
	process: PromptImageProcessor,
	autoResize: boolean,
): Promise<ImageContent[]> {
	if (attachments === undefined) return [];
	if (!Array.isArray(attachments)) throw new Error("图片附件格式无效");
	if (attachments.length > MAX_PROMPT_IMAGES) {
		throw new Error(`一次最多附加 ${String(MAX_PROMPT_IMAGES)} 张图片`);
	}
	let total = 0;
	const images: ImageContent[] = [];
	for (const attachment of attachments) {
		if (!attachment || typeof attachment !== "object") throw new Error("图片附件格式无效");
		validateName(attachment.name);
		const mimeType = normalizeMimeType(attachment.mimeType);
		const bytes = decodeData(attachment.data);
		total += bytes.length;
		if (total > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
			throw new Error(`图片总量超过 ${String(MAX_PROMPT_IMAGE_TOTAL_BYTES / 1024 / 1024)} MiB 限制`);
		}
		const result = await process(bytes, mimeType, { autoResizeImages: autoResize });
		if (!result.ok) throw new Error(result.message ?? "图片处理失败");
		if (typeof result.data !== "string" || typeof result.mimeType !== "string") {
			throw new Error("图片处理失败");
		}
		images.push({ type: "image", data: result.data, mimeType: result.mimeType });
	}
	return images;
}
