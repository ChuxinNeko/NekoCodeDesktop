import { describe, expect, test } from "bun:test";
import {
	MAX_PROMPT_IMAGE_BYTES,
	MAX_PROMPT_IMAGE_TOTAL_BYTES,
	MAX_PROMPT_IMAGES,
	type PromptImageAttachment,
} from "../shared/agent";
import { preparePromptImages, type PromptImageProcessor } from "./prompt-images";

const okProcessor: PromptImageProcessor = (bytes, mimeType, options) =>
	Promise.resolve({
		ok: true,
		data: Buffer.from(bytes).toString("base64"),
		mimeType,
		message: options.autoResizeImages ? undefined : "unused",
	});

function attachment(data: Uint8Array | string, overrides: Partial<PromptImageAttachment> = {}): PromptImageAttachment {
	return {
		name: "shot.png",
		mimeType: "image/png",
		data: typeof data === "string" ? data : Buffer.from(data).toString("base64"),
		...overrides,
	};
}

describe("preparePromptImages", () => {
	test("returns nothing when no attachments are provided", async () => {
		expect(await preparePromptImages(undefined, okProcessor, true)).toEqual([]);
		expect(await preparePromptImages([], okProcessor, true)).toEqual([]);
	});

	test("normalizes each image through the processor", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const images = await preparePromptImages(
			[attachment(bytes), attachment(new Uint8Array([5, 6]), { mimeType: "image/jpg" })],
			okProcessor,
			true,
		);
		expect(images).toEqual([
			{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" },
			{ type: "image", data: Buffer.from([5, 6]).toString("base64"), mimeType: "image/jpeg" },
		]);
	});

	test("rejects a non-array images field", async () => {
		await expect(
			preparePromptImages("not-an-array" as never, okProcessor, true),
		).rejects.toThrow();
	});

	test("rejects more than the maximum attachment count", async () => {
		const many = Array.from({ length: MAX_PROMPT_IMAGES + 1 }, () => attachment(new Uint8Array([1])));
		await expect(preparePromptImages(many, okProcessor, true)).rejects.toThrow();
	});

	test("rejects unsupported MIME types including svg", async () => {
		await expect(
			preparePromptImages([attachment("<svg/>", { mimeType: "image/svg+xml" })], okProcessor, true),
		).rejects.toThrow();
		await expect(
			preparePromptImages([attachment(new Uint8Array([1]), { mimeType: "application/pdf" })], okProcessor, true),
		).rejects.toThrow();
	});

	test("rejects malformed base64 instead of silently decoding", async () => {
		await expect(
			preparePromptImages([attachment("not!!base64!!")], okProcessor, true),
		).rejects.toThrow();
		await expect(
			preparePromptImages([attachment("AAA")], okProcessor, true),
		).rejects.toThrow();
	});

	test("rejects a single image over the per-file raw limit", async () => {
		const data = Buffer.alloc(MAX_PROMPT_IMAGE_BYTES + 1).toString("base64");
		await expect(preparePromptImages([attachment(data)], okProcessor, true)).rejects.toThrow();
	});

	test("rejects attachments whose combined raw size exceeds the total limit", async () => {
		const perFile = Math.floor(MAX_PROMPT_IMAGE_TOTAL_BYTES / 2) + 1;
		const data = Buffer.alloc(perFile).toString("base64");
		await expect(
			preparePromptImages([attachment(data), attachment(data)], okProcessor, true),
		).rejects.toThrow();
	});

	test("rejects empty or overlong names", async () => {
		await expect(
			preparePromptImages([attachment(new Uint8Array([1]), { name: "  " })], okProcessor, true),
		).rejects.toThrow();
		await expect(
			preparePromptImages([attachment(new Uint8Array([1]), { name: "x".repeat(256) })], okProcessor, true),
		).rejects.toThrow();
	});

	test("propagates processor failure", async () => {
		const failing: PromptImageProcessor = () => Promise.resolve({ ok: false, message: "too tall" });
		await expect(
			preparePromptImages([attachment(new Uint8Array([1]))], failing, true),
		).rejects.toThrow("too tall");
	});

	test("passes the auto-resize setting through to the processor", async () => {
		let seen: boolean | undefined;
		const probe: PromptImageProcessor = (_bytes, _mime, options) => {
			seen = options.autoResizeImages;
			return Promise.resolve({ ok: true, data: "AAAA", mimeType: "image/png" });
		};
		await preparePromptImages([attachment(new Uint8Array([1]))], probe, false);
		expect(seen).toBe(false);
	});
});
