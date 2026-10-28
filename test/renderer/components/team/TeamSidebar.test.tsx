import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { TeamSidebar } from "../../../../src/renderer/src/components/team/TeamSidebar";
import type { TeamWorkspaceSnapshot } from "../../../../src/shared/team-workspace";
const member = (id: string, name: string) => ({ id, name, role: "Developer", instructions: "", modelKey: "", thinkingLevel: "off" as const, access: "full" as const });
const room = (id: string, members: string[], direct = false) => ({ id, name: id, members, direct, adminId: "chief", mode: "admin" as const, notice: "", cwd: "", createdAt: 1 });
const state: TeamWorkspaceSnapshot = {
 team: { members: [member("chief", "Chief"), member("coder", "Coder"), member("reviewer", "Reviewer")], adminId: "chief", parallel: true, peerDelegation: false, maxAssignments: 4 },
 rooms: [room("private-coder", ["coder"], true), room("Launch group", ["chief", "coder"])],
 posts: [{ id: "p", roomId: "private-coder", memberId: "coder", name: "Coder", text: "Latest reply", kind: "message", at: 30 }],
 work: [{ id: "w", roomId: "Launch group", memberId: "chief", status: "working", task: "Review the release", text: "", startedAt: 40, updatedAt: 40 }], memory: [],
};
const noop = () => {};
const render = (selected: string | null = null) => renderToStaticMarkup(<I18nProvider><TeamSidebar state={state} tab="chat" selected={selected} onNavigate={noop} onOpenRoom={noop} onDirect={noop} onNewGroup={noop} /></I18nProvider>);
describe("bot contact sidebar", () => {
 test("places the main bot above one mixed list ordered by recent activity", () => {
  const html = render();
  expect(html.indexOf('aria-label="Chief"')).toBeLessThan(html.indexOf('aria-label="Launch group'));
  expect(html.indexOf('aria-label="Launch group')).toBeLessThan(html.indexOf('aria-label="Coder"'));
  expect(html.indexOf('aria-label="Coder"')).toBeLessThan(html.indexOf('aria-label="Reviewer"'));
  expect(html).toContain("Latest reply"); expect(html).toContain("Review the release");
  expect(html).not.toContain("private-coder");
 });
 test("selects the bot row for a direct conversation and keeps workspace tools accessible", () => {
  const html = render("private-coder");
  expect(html).toContain('aria-label="Coder" aria-current="page"');
  expect(html).toContain('aria-label="搜索成员与会话"');
  expect(html).toContain('aria-label="创建群聊"');
  expect(html).toContain('aria-label="收起侧边栏"');
  expect(html).toContain('aria-label="记忆"');
  expect(html).toContain('aria-label="成员与设置"');
 });
});
