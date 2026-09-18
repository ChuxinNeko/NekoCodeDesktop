import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionSummary } from "../shared/agent";
import { SessionList } from "../renderer/src/components/sessions/SessionList";
import { I18nProvider } from "../renderer/src/i18n";

const session = (id: string, cwd: string): SessionSummary => ({ id, cwd, sessionFile: `/sessions/${id}.jsonl`, title: `Thread ${id}`, preview: "preview", titlePending: false, createdAt: 1, updatedAt: 2, messageCount: 2 });
const render = (sessions: SessionSummary[], workspaces: string[] = []) => renderToStaticMarkup(createElement(I18nProvider, {
	children: createElement(SessionList, { sessions, currentCwd: "/one", workspaces, activeId: "a", busy: false, streaming: true, loading: false, onAddWorkspace() {}, onNewSession() {}, onOpen() {}, onRename() {}, onDelete() {} }),
}));

describe("sidebar workspace folders", () => {
	test("renders separate folder sections, nested sessions and accessible controls", () => {
		const html = render([session("a", "/one"), session("b", "/two")]);
		expect(html).toContain('data-workspace="/one"');
		expect(html).toContain('data-workspace="/two"');
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain('aria-current="page"');
		expect(html).toContain("在 two 中新建会话");
		expect(html).toContain("添加工作区");
		expect(html).not.toContain(">preview</span>");
		expect(html.indexOf("Thread a")).toBeLessThan(html.indexOf('data-workspace="/two"'));
		expect(html.indexOf("Thread b")).toBeGreaterThan(html.indexOf('data-workspace="/two"'));
	});
	test("empty workspaces retain their add-thread action", () => {
		const html = render([], ["/empty"]);
		expect(html).toContain('data-workspace="/empty"');
		expect(html).toContain("暂无会话");
		expect(html).toContain("在 empty 中新建会话");
	});
	test("large groups start with five rows and a show-more action", () => {
		const html = render(Array.from({ length: 8 }, (_, i) => session(String(i), "/one")));
		expect(html.match(/data-session-file=/g)).toHaveLength(5);
		expect(html).toContain("显示更多（3）");
	});
});
