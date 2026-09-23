import { describe, expect, test } from "bun:test";
import { MAX_PROMPT_IMAGE_BYTES } from "../../../../shared/agent";
import { fileToPromptImage, imageMimeType, SUPPORTED_PROMPT_IMAGE_TYPES } from "./composer-images";

describe("imageMimeType", () => {
	test("accepts declared supported types", () => {
		expect(imageMimeType({ name: "a.png", type: "image/png" })).toBe("image/png");
		expect(imageMimeType({ name: "a.webp", type: "image/webp" })).toBe("image/webp");
		expect(imageMimeType({ name: "a.gif", type: "image/gif" })).toBe("image/gif");
		expect(imageMimeType({ name: "a.bmp", type: "image/bmp" })).toBe("image/bmp");
	});

	test("normalizes image/jpg to image/jpeg", () => {
		expect(imageMimeType({ name: "a.jpg", type: "image/jpg" })).toBe("image/jpeg");
		expect(imageMimeType({ name: "a.jpeg", type: "image/jpeg" })).toBe("image/jpeg");
	});

	test("rejects svg and unrelated types even with an image-looking name", () => {
		expect(imageMimeType({ name: "a.svg", type: "image/svg+xml" })).toBeNull();
		expect(imageMimeType({ name: "a.png", type: "application/pdf" })).toBeNull();
		expect(imageMimeType({ name: "a.png", type: "text/plain" })).toBeNull();
	});

	test("infers the type from the extension when the browser type is blank", () => {
		expect(imageMimeType({ name: "photo.JPG", type: "" })).toBe("image/jpeg");
		expect(imageMimeType({ name: "photo.jpeg", type: "" })).toBe("image/jpeg");
		expect(imageMimeType({ name: "photo.PNG", type: "" })).toBe("image/png");
		expect(imageMimeType({ name: "photo.webp", type: "" })).toBe("image/webp");
		expect(imageMimeType({ name: "photo.gif", type: "" })).toBe("image/gif");
		expect(imageMimeType({ name: "photo.bmp", type: "" })).toBe("image/bmp");
	});

	test("rejects svg and unknown extensions with a blank type", () => {
		expect(imageMimeType({ name: "icon.svg", type: "" })).toBeNull();
		expect(imageMimeType({ name: "notes.txt", type: "" })).toBeNull();
		expect(imageMimeType({ name: "noext", type: "" })).toBeNull();
	});

	test("exports exactly the supported set", () => {
		expect([...SUPPORTED_PROMPT_IMAGE_TYPES].sort()).toEqual(
			["image/bmp", "image/gif", "image/jpeg", "image/png", "image/webp"].sort(),
		);
	});
});

describe("fileToPromptImage", () => {
	test("returns name, normalized mime, and base64 of the file bytes", async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const file = new File([bytes], " shot.PNG ", { type: "" });
		const image = await fileToPromptImage(file);
		expect(image.name).toBe("shot.PNG");
		expect(image.mimeType).toBe("image/png");
		expect(Buffer.from(image.data, "base64").equals(Buffer.from(bytes))).toBe(true);
	});

	test("handles files larger than one conversion chunk", async () => {
		const bytes = new Uint8Array(0x8000 * 2 + 7).map((_, i) => i % 251);
		const file = new File([bytes], "big.png", { type: "image/png" });
		const image = await fileToPromptImage(file);
		expect(Buffer.from(image.data, "base64").equals(Buffer.from(bytes))).toBe(true);
	});

	test("rejects unsupported types", async () => {
		await expect(fileToPromptImage(new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" }))).rejects.toThrow();
	});

	test("rejects files over the per-image raw limit", async () => {
		const file = new File([new Uint8Array(MAX_PROMPT_IMAGE_BYTES + 1)], "huge.png", { type: "image/png" });
		await expect(fileToPromptImage(file)).rejects.toThrow();
	});

	test("rejects empty files and empty names", async () => {
		await expect(fileToPromptImage(new File([], "empty.png", { type: "image/png" }))).rejects.toThrow();
		await expect(fileToPromptImage(new File([new Uint8Array(4)], " ", { type: "image/png" }))).rejects.toThrow();
	});
});
