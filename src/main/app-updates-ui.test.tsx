import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RELEASES_URL, type UpdateCheckResult } from "../shared/updates";

const previousWindow = globalThis.window;
Object.defineProperty(globalThis, "window", { configurable: true, value: { nekocode: {} } });
const { AboutSettingsView } = await import("../renderer/src/components/settings/AboutSettings");
const { ReleaseNotes } = await import("../renderer/src/components/updates/ReleaseNotes");
const { I18nProvider } = await import("../renderer/src/i18n");
Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });

const render = (result: UpdateCheckResult | null = null, busy = false) => renderToStaticMarkup(
	<I18nProvider><AboutSettingsView info={{ version: "0.0.1", development: true, releasesUrl: RELEASES_URL }} result={result} busy={busy} loading={false} error={null} onCheck={() => {}} onOpen={() => {}} /></I18nProvider>,
);
const base = { currentVersion: "0.0.1", checkedAt: 1000 };

describe("About update controls", () => {
	test("release notes render headings and lists without HTML, images or unsafe links", () => {
		const html = renderToStaticMarkup(<I18nProvider><ReleaseNotes notes={"## 新功能\n- 分模型统计\n\n[说明](https://github.com/example)\n\n![tracking](https://untrusted.example/image.png)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))"} onOpen={() => {}} /></I18nProvider>);
		expect(html).toContain("<h2>新功能</h2>");
		expect(html).toContain("<li>分模型统计</li>");
		expect(html).toContain('href="https://github.com/example"');
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("javascript:");
	});
	test("empty release notes get a readable fallback", () => {
		expect(renderToStaticMarkup(<I18nProvider><ReleaseNotes notes="  " onOpen={() => {}} /></I18nProvider>)).toContain("该版本未提供更新说明");
	});
	test("shows the application version and manual check action", () => {
		const html = render();
		expect(html).toContain("v0.0.1");
		expect(html).toContain("开发版");
		expect(html).toContain("检查更新");
		expect(html).not.toContain("当前已是最新正式版");
	});
	test("checking disables the action", () => {
		const html = render(null, true);
		expect(html).toContain("正在检查");
		expect(html).toContain("disabled");
		expect(html).toContain('aria-busy="true"');
	});
	test("a newer release shows download, release date and escaped notes", () => {
		const html = render({ ...base, status: "available", release: { version: "0.1.0", tag: "v0.1.0", name: "NekoCode 0.1", url: `${RELEASES_URL}/tag/v0.1.0`, notes: "<script>alert(1)</script>", publishedAt: "2026-09-19T00:00:00Z" } });
		expect(html).toContain("发现新版本：v0.1.0");
		expect(html).toContain("前往 GitHub 下载");
		expect(html).toContain("更新说明");
		expect(html).not.toContain("<script>");
	});
	test("no release and failed checks are not presented as current", () => {
		expect(render({ ...base, status: "no-release" })).toContain("暂未发布正式版本");
		const html = render({ ...base, status: "error", error: "network" });
		expect(html).toContain("无法连接 GitHub");
		expect(html).not.toContain("当前已是最新正式版");
		expect(html).not.toContain("前往 GitHub 下载");
	});
});
