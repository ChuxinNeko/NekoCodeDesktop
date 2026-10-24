import { describe, expect, test } from "bun:test";
import { searchSettings } from "../../../src/renderer/src/lib/settingsSearch";
import { zhCN } from "../../../src/renderer/src/i18n/locales/zh-CN";
import { en } from "../../../src/renderer/src/i18n/locales/en";
import type { TranslateFn } from "../../../src/renderer/src/i18n";
import { settingsTextMatches } from "../../../src/renderer/src/lib/settingsSearchTarget";

const sections = [
	{ id: "general", labelKey: "settings.section.general" },
	{ id: "appearance", labelKey: "settings.section.appearance" },
	{ id: "providers", labelKey: "settings.section.providers" },
	{ id: "about", labelKey: "settings.section.about" },
	{ id: "ssh", labelKey: "settings.section.ssh" },
] as const;
const t: TranslateFn = (key) => zhCN[key];

describe("settings search", () => {
	test("blank and cleared queries restore all sections in navigation order", () => {
		expect(searchSettings(sections, "  ", t).map((entry) => entry.section)).toEqual([...sections]);
	});
	test("finds settings inside a section, not just its navigation label", () => {
		const result = searchSettings(sections, "自动重试", t);
		expect(result.map((entry) => entry.section.id)).toEqual(["general"]);
		expect(result[0].match).toBe("自动重试次数");
		expect(result[0].matchKey).toBe("settings.autoRetryCount");
		expect(searchSettings(sections, "字体", t).some((entry) => entry.section.id === "appearance")).toBe(true);
		expect(searchSettings(sections, "检查更新", t).map((entry) => entry.section.id)).toEqual(["about"]);
		expect(searchSettings(sections, "托盘", t).map((entry) => entry.section.id)).toEqual(["general"]);
	});
	test("matches bilingual text, full-width characters, case, and multiple words", () => {
		expect(searchSettings(sections, "  ＡＰＩ   ＫＥＹ  ", t).map((entry) => entry.section.id)).toEqual(["providers"]);
		expect(searchSettings(sections, "外观 字体", t).map((entry) => entry.section.id)).toEqual(["appearance"]);
		const english = searchSettings(sections, "自动重试", (key) => en[key]);
		expect(english[0].match).toBe(en["settings.autoRetryCount"]);
	});
	test("matches category names and only returns sections available to this client", () => {
		expect(searchSettings(sections, "通用", t)[0]).toEqual({ section: sections[0], match: null });
		expect(searchSettings(sections.filter((section) => section.id !== "ssh"), "ssh", t)).toEqual([]);
		expect(searchSettings(sections, "zzzz-no-such-setting", t)).toEqual([]);
	});
	test("shortcut commands can be found from the settings navigation", () => {
		const result = searchSettings([{ id: "shortcuts", labelKey: "settings.section.shortcuts" }], "快捷键 新会话", t);
		expect(result[0].matchKey).toBe("sidebar.newSession");
	});
});

test("search destinations match rendered labels and interpolated hints exactly", () => {
	expect(settingsTextMatches("代码字体", "代码字体")).toBe(true);
	expect(settingsTextMatches("代码字体", "代码字体大小")).toBe(false);
	expect(settingsTextMatches("已安装 {count} 个主题。", "已安装 24 个主题。")).toBe(true);
	expect(settingsTextMatches("UI (系统) 字体", "UI (系统) 字体")).toBe(true);
	expect(settingsTextMatches("  代码\n字体 ", "代码 字体")).toBe(true);
});
