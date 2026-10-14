import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { AgentCell } from "../../../../src/shared/agent";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { ConversationTimeline } from "../../../../src/renderer/src/components/chat/ConversationTimeline";
import { activeTimelineIndex, timelineEntries, timelinePreview, timelineTime } from "../../../../src/renderer/src/lib/timeline";

const user = (id: string, text: string, timestamp = 1): AgentCell => ({ id, type: "user", text, timestamp });
const reply = (id: string): AgentCell => ({ id, type: "assistant", text: "ok", thinking: "", streaming: false, timestamp: 1 } as AgentCell);

describe("conversation timeline data", () => {
	test("lists only the user's prompts, in order", () => {
		const entries = timelineEntries([user("u1", "first"), reply("a1"), user("u2", "second"), reply("a2")]);
		expect(entries.map((e) => [e.id, e.preview])).toEqual([["u1", "first"], ["u2", "second"]]);
	});

	test("preview is one markdown-free line, truncated", () => {
		expect(timelinePreview("**修复** `price.js`\n\n```ts\nconst a = 1;\n```\n见 [文档](https://x.y)")).toBe("修复 price.js [code] 见 文档");
		const long = timelinePreview("字".repeat(200));
		expect(long.length).toBe(80);
		expect(long.endsWith("…")).toBe(true);
	});

	test("the current prompt is the last one past the reading line", () => {
		const tops = [0, 500, 1500, 3000];
		expect(activeTimelineIndex(tops, 0, 900)).toBe(0);
		expect(activeTimelineIndex(tops, 300, 900)).toBe(1);   // line at 600
		expect(activeTimelineIndex(tops, 1300, 900)).toBe(2);  // line at 1600
		expect(activeTimelineIndex(tops, 9000, 900)).toBe(3);
		expect(activeTimelineIndex([], 0, 900)).toBe(-1);
		// Rows not yet in the DOM sort last and never become current.
		expect(activeTimelineIndex([0, Number.POSITIVE_INFINITY], 5000, 900)).toBe(0);
	});

	test("time label shortens for today and this year", () => {
		const now = new Date(2026, 9, 14, 18, 0).getTime();
		expect(timelineTime(new Date(2026, 9, 14, 9, 5).getTime(), now)).toBe("09:05");
		expect(timelineTime(new Date(2026, 2, 3, 23, 59).getTime(), now)).toBe("03-03 23:59");
		expect(timelineTime(new Date(2025, 11, 31, 8, 0).getTime(), now)).toBe("2025-12-31 08:00");
		expect(timelineTime(0, now)).toBe("");
	});
});

describe("ConversationTimeline", () => {
	const render = (cells: AgentCell[]) => renderToString(
		<I18nProvider><ConversationTimeline cells={cells} scrollRef={{ current: null }} onJump={() => undefined} /></I18nProvider>);

	test("hidden until there is more than one prompt to move between", () => {
		expect(render([user("u1", "only one"), reply("a1")])).toBe("");
	});

	test("one labelled, keyboard-reachable stop per prompt", () => {
		const html = render([user("u1", "第一条"), reply("a1"), user("u2", "第二条"), user("u3", "第三条")]);
		expect(html).toContain("data-conversation-timeline");
		expect(html.match(/<button/g)?.length).toBe(3);
		expect(html).toMatch(/aria-label="[^"]*1[^"]*第一条"/);
		expect(html).toMatch(/aria-label="[^"]*3[^"]*第三条"/);
	});
});
