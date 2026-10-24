import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamConversationMessages } from "../../../src/renderer/src/components/team/TeamConversationMessages";
import { I18nProvider } from "../../../src/renderer/src/i18n";
import { DEFAULT_TEAM } from "../../../src/shared/team";
import type { TeamPost, TeamWork } from "../../../src/shared/team-workspace";

const posts: TeamPost[] = [
	{ id: "opening", roomId: "room", memberId: "chief", name: "Chief", kind: "message", text: "先制作自我介绍页面，再请成员审查。", at: 1, status: "done" },
	{ id: "assign1", roomId: "room", memberId: "chief", name: "Chief", kind: "assignment", text: "@Coder 编写 HTML", at: 2 },
	{ id: "assign2", roomId: "room", memberId: "chief", name: "Chief", kind: "assignment", text: "@Reviewer 检查页面", at: 3 },
	{ id: "report", roomId: "room", memberId: "coder", name: "Coder", kind: "message", text: "已写好页面。", at: 4, status: "streaming", workId: "work" },
];
const work: TeamWork = { id: "work", roomId: "room", memberId: "coder", task: "写 HTML", text: "此处是整轮累计文字，不应作为另一个回复重复显示。", status: "working", startedAt: 1, updatedAt: 4 };
const render = (messages: TeamPost[], active: TeamWork[]) => renderToStaticMarkup(<I18nProvider><TeamConversationMessages team={DEFAULT_TEAM} posts={messages} work={active} onStop={() => {}} /></I18nProvider>);

test("opening and two assignments remain separate named bubbles while members work and after finishing", () => {
	const live = render(posts, [work]);
	const finished = render(posts.map(post => ({ ...post, status: "done" })), []);
	for (const html of [live, finished]) {
		expect((html.match(/data-team-post=/g) ?? []).length).toBe(4);
		expect((html.match(/data-message-kind="assignment"/g) ?? []).length).toBe(2);
		expect(html.indexOf("先制作自我介绍")).toBeLessThan(html.indexOf("@Coder"));
		expect(html.indexOf("编写 HTML")).toBeLessThan(html.indexOf("检查页面"));
		expect(html).not.toContain("此处是整轮累计文字");
	}
	expect(live).toContain("正在输入");
	expect(finished).not.toContain("正在输入");
});
