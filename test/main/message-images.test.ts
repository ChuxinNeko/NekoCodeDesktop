import { expect, test } from "bun:test";
import { projectMessages } from "../../src/main/agent-projection";
import { AcpProjection } from "../../src/main/acp/projection";

const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=", name: "paste.png" };
const attachment = { mimeType: image.mimeType, data: image.data, name: image.name };

test("ordinary history preserves mixed and image-only user messages", () => {
	const cells = projectMessages([
		{ role: "user", timestamp: 1, content: [{ type: "text", text: "Look" }, image, image] },
		{ role: "user", timestamp: 2, content: [image] },
	]);
	expect(cells).toHaveLength(2);
	expect(cells[0]).toMatchObject({ text: "Look", images: [attachment, attachment] });
	expect(cells[1]).toMatchObject({ text: "", images: [attachment] });
});

test("ACP live prompts and steering retain attachments", () => {
	const projection = new AcpProjection();
	projection.addUserPrompt("", [attachment]);
	projection.addSteeringPrompt("Look", [attachment]);
	expect(projection.cells[0]).toMatchObject({ text: "", images: [attachment] });
	expect(projection.cells[1]).toMatchObject({ text: "Look", images: [attachment] });
});

test("ACP replay joins image and text chunks without merging distinct messages", () => {
	const projection = new AcpProjection();
	for (const content of [image, { type: "text", text: "Look" }, image]) {
		projection.apply({ sessionUpdate: "user_message_chunk", messageId: "one", content });
	}
	projection.apply({ sessionUpdate: "user_message_chunk", messageId: "two", content: image });
	expect(projection.cells).toHaveLength(2);
	expect(projection.cells[0]).toMatchObject({ text: "Look", images: [attachment, attachment] });
	expect(projection.cells[1]).toMatchObject({ text: "", images: [attachment] });
});
