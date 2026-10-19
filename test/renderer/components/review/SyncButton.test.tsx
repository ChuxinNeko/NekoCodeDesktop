import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitRemoteActionKind, RepoStatus } from "../../../../src/shared/git";
import { SyncButton } from "../../../../src/renderer/src/components/review/SyncButton";
import { I18nProvider } from "../../../../src/renderer/src/i18n";

const status = { remote: "origin", upstream: "origin/main", ahead: 0, behind: 0, hasCommits: true } as RepoStatus;
const render = (busy: GitRemoteActionKind | null, patch: Partial<RepoStatus> = {}) => renderToStaticMarkup(
  <I18nProvider><SyncButton status={{ ...status, ...patch }} busy={busy} onRun={() => undefined} /></I18nProvider>,
);

describe("review sync feedback", () => {
  test("idle fetch remains available", () => {
    const html = render(null);
    expect(html).toContain("抓取 origin");
    expect(html).not.toContain('aria-busy="true"');
    expect(html).not.toMatch(/\sdisabled(?:=|\s|>)/);
  });

  test("fetch shows progress and prevents another click", () => {
    const html = render("fetch");
    expect(html).toContain("正在抓取 origin");
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/\sdisabled(?:=|\s|>)/);
  });

  test("progress follows the running operation when polling changes the suggested action", () => {
    const html = render("push", { behind: 1 });
    expect(html).toContain("正在推送至 origin");
    expect(html).not.toContain("正在拉取");
    expect(html).toContain('aria-busy="true"');
  });

  test("pull and branch publication have explicit progress text", () => {
    expect(render("pull", { behind: 2 })).toContain("正在拉取 origin");
    expect(render("push", { upstream: null })).toContain("正在推送至 origin");
  });
});
