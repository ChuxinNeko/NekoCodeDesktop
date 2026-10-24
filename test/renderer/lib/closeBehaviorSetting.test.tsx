import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CloseBehaviorSetting } from "../../../src/renderer/src/components/settings/GeneralSettings";
import { I18nProvider } from "../../../src/renderer/src/i18n";

test("the close behavior control shows the saved choice and exposes a search anchor", () => {
	const render = (value: "quit" | "tray", disabled = false) => renderToStaticMarkup(<I18nProvider>
		<CloseBehaviorSetting value={value} disabled={disabled} onChange={() => {}} />
	</I18nProvider>);
	const tray = render("tray");
	expect(tray).toContain("最小化到托盘");
	expect(tray).toContain('data-settings-key="settings.closeBehavior"');
	expect(tray).toContain("关闭窗口时");
	expect(render("quit", true)).toContain("关闭整个应用");
	expect(render("quit", true)).toContain("disabled");
});
