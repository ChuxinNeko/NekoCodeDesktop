import { describe, expect, test } from "bun:test";
import { oneBotMessage } from "./onebot";

const SELF = "100";

describe("oneBotMessage", () => {
	test("reads a private message from segments", () => {
		const message = oneBotMessage(
			{
				post_type: "message",
				message_type: "private",
				user_id: 10001,
				sender: { nickname: "阿猫" },
				message: [{ type: "text", data: { text: "  改一下登录页  " } }],
			},
			SELF,
		);

		expect(message).toEqual({
			chat: { kind: "private", id: "10001" },
			senderId: "10001",
			senderName: "阿猫",
			text: "改一下登录页",
			addressed: true,
		});
	});

	test("a group message counts as addressed only when it mentions the bot", () => {
		const event = (mentioned: string) => ({
			post_type: "message",
			message_type: "group",
			group_id: 55555,
			user_id: 10001,
			sender: { card: "猫" },
			message: [
				{ type: "at", data: { qq: mentioned } },
				{ type: "text", data: { text: " 跑一下测试" } },
			],
		});

		expect(oneBotMessage(event(SELF), SELF)?.addressed).toBe(true);
		expect(oneBotMessage(event("999"), SELF)?.addressed).toBe(false);
		// @全体成员 names everyone, the bot included.
		expect(oneBotMessage(event("all"), SELF)?.addressed).toBe(true);
	});

	test("falls back to the CQ-coded string when there is no segment array", () => {
		const message = oneBotMessage(
			{
				post_type: "message",
				message_type: "group",
				group_id: 55555,
				user_id: 10001,
				raw_message: `[CQ:at,qq=${SELF}] 看看 [CQ:image,file=a.png] 这个报错`,
			},
			SELF,
		);

		expect(message?.addressed).toBe(true);
		// The image segment is dropped rather than passed through as markup.
		expect(message?.text).toBe("看看   这个报错");
		expect(message?.senderName).toBe("10001");
	});

	test("ignores an event that is neither a private nor a group message", () => {
		expect(oneBotMessage({ post_type: "message", message_type: "guild", user_id: 1 }, SELF)).toBeNull();
		expect(oneBotMessage({ post_type: "message", message_type: "private" }, SELF)).toBeNull();
	});
});
