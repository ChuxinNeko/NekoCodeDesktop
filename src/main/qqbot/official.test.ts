import { describe, expect, test } from "bun:test";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { toKeyboard, toMessage } from "./official";

/**
 * The protocol itself belongs to `@tencent-connect/qqbot-nodejs` now — token
 * refresh, gateway heartbeat, `msg_seq`, chunked upload. What is still ours, and
 * what these cover, is the mapping between the SDK's vocabulary and this app's.
 */
function inbound(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
	return {
		rawEventType: "C2C_MESSAGE_CREATE",
		kind: "c2c",
		senderId: "user-openid",
		content: "改一下登录页",
		messageId: "msg-1",
		timestamp: "2026-09-21T00:00:00Z",
		replyTarget: { scope: "c2c", targetId: "user-openid", msgId: "msg-1" },
		raw: {} as QQBotInboundMessage["raw"],
		...overrides,
	} as QQBotInboundMessage;
}

describe("toMessage", () => {
	test("maps a C2C message onto a private chat", () => {
		expect(toMessage(inbound())).toMatchObject({
			chat: { kind: "private", id: "user-openid" },
			text: "改一下登录页",
			addressed: true,
			replyToken: "msg-1",
		});
	});

	test("maps a group message and strips the mention markup", () => {
		const message = toMessage(
			inbound({
				kind: "group",
				rawEventType: "GROUP_AT_MESSAGE_CREATE",
				groupOpenid: "group-openid",
				content: "<@!12345> 跑一下测试",
				replyTarget: { scope: "group", targetId: "group-openid", msgId: "msg-2" },
			}),
		);

		expect(message).toMatchObject({ chat: { kind: "group", id: "group-openid" }, text: "跑一下测试" });
	});

	test("ignores the bot's own messages", () => {
		// A bot answering its own output is a loop with a monthly bill attached.
		expect(toMessage(inbound({ senderIsBot: true }))).toBeNull();
	});

	test("carries attachments, including QQ's own voice transcript", () => {
		const message = toMessage(
			inbound({
				content: "",
				attachments: [
					{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png" },
					{ content_type: "audio/silk", url: "https://example.com/v.silk", asr_refer_text: "把按钮改成圆角" },
				],
			}),
		);

		expect(message?.attachments).toEqual([
			{ kind: "image", url: "https://example.com/a.png", name: "a.png", contentType: "image/png" },
			{ kind: "voice", url: "https://example.com/v.silk", contentType: "audio/silk", transcript: "把按钮改成圆角" },
		]);
	});

	test("carries the quoted message a reply points at", () => {
		const message = toMessage(
			inbound({
				content: "这个改一下",
				msgElements: [{ msg_idx: "1", content: "登录页的按钮是方角的" }],
			}),
		);

		expect(message?.quote).toEqual({ text: "登录页的按钮是方角的" });
	});

	test("leaves quote unset when nothing was quoted", () => {
		expect(toMessage(inbound())?.quote).toBeUndefined();
	});
});

describe("toKeyboard", () => {
	test("lays buttons out two to a row", () => {
		const keyboard = toKeyboard([
			{ id: "a", label: "选项 A", data: "ans|r|q|a" },
			{ id: "b", label: "选项 B", data: "ans|r|q|b" },
			{ id: "c", label: "选项 C", data: "ans|r|q|c" },
		]);

		expect(keyboard?.content.rows).toHaveLength(2);
		expect(keyboard?.content.rows[0].buttons.map((button) => button.id)).toEqual(["a", "b"]);
		expect(keyboard?.content.rows[1].buttons).toHaveLength(1);
		expect(keyboard?.content.rows[0].buttons[0].action.data).toBe("ans|r|q|a");
	});

	test("is absent when there is nothing to offer", () => {
		expect(toKeyboard([])).toBeUndefined();
		expect(toKeyboard(undefined)).toBeUndefined();
	});
});
