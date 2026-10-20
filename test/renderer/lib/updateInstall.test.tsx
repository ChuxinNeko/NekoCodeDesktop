import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../../src/renderer/src/i18n";
import { UpdateInstallActions } from "../../../src/renderer/src/components/updates/UpdateInstall";
import type { AppRelease } from "../../../src/shared/updates";

test("install handoff explains the progress window and automatic restart without a second install button", () => {
	const release = { version: "0.2.0", tag: "v0.2.0", url: "https://example.test/release" } as AppRelease;
	const html = renderToStaticMarkup(<I18nProvider><UpdateInstallActions release={release}
		state={{ phase: "installing", version: release.version }} onOpen={() => {}} /></I18nProvider>);
	expect(html).toContain('role="status"');
	expect(html).toContain("请在安装进度窗口中等待");
	expect(html).toContain("自动重新打开");
	expect(html).not.toContain("<button");
});
