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
		expect((html.match(/data-team-bubble="bot"/g) ?? []).length).toBe(4);
		expect((html.match(/data-message-kind="assignment"/g) ?? []).length).toBe(2);
		expect(html.indexOf("先制作自我介绍")).toBeLessThan(html.indexOf("@Coder"));
		expect(html.indexOf("编写 HTML")).toBeLessThan(html.indexOf("检查页面"));
		expect(html).not.toContain("此处是整轮累计文字");
	}
	expect(live).toContain("正在输入");
	expect(finished).not.toContain("正在输入");
});

test("roster mentions and all are highlighted in prose without touching code, emails or links", () => {
	const text = "**@coder**，请 @Reviewer 协助 @all。 @Unknown name@Coder.com @CoderExtra @Coder_2 @Coder-2\n\n`@Coder` [@Reviewer](https://example.com)\n\n```text\n@Coder\n```";
	const html = render([{ ...posts[0], text }], []);
	expect((html.match(/data-team-mention=/g) ?? []).length).toBe(3);
	expect(html).toContain('data-team-mention="coder">@coder</span>');
	expect(html).toContain('data-team-mention="reviewer">@Reviewer</span>');
	expect(html).toContain('data-team-mention="all">@all</span>');
	expect(html).toContain("name@Coder.com");
	expect(html).toContain("@Unknown");
	expect(html).toContain("<code>@Coder</code>");
	expect(html).toContain('class="language-text">@Coder');
});

test("user messages have their own bubble and use the same mention highlighting", () => {
	const html = render([{ ...posts[0], memberId: "user", name: "User", text: "@Coder 请帮忙" }], []);
	expect(html).toContain('data-team-bubble="user"');
	expect(html).not.toContain('data-team-bubble="bot"');
	expect(html).toContain('data-team-mention="coder"');
});

test("custom Chinese bot names are recognized without highlighting partial names", () => {
	const team = { ...DEFAULT_TEAM, members: [...DEFAULT_TEAM.members, { ...DEFAULT_TEAM.members[1], id: "designer", name: "设计师" }] };
	const html = renderToStaticMarkup(<I18nProvider><TeamConversationMessages team={team} posts={[{ ...posts[0], text: "@设计师，请与 @Coder 配合。@设计师助理" }]} work={[]} onStop={() => {}} /></I18nProvider>);
	expect((html.match(/data-team-mention=/g) ?? []).length).toBe(2);
	expect(html).toContain('data-team-mention="designer">@设计师</span>');
	expect(html).toContain("@设计师助理");
});
