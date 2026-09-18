import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginCatalogEntry } from "../shared/plugins";

const previousWindow = globalThis.window;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: { nekocode: {} },
});
const { PluginCatalogCard } =
	await import("../renderer/src/components/settings/PluginCatalog");
const { PluginSettings } =
	await import("../renderer/src/components/settings/PluginSettings");
const { I18nProvider } = await import("../renderer/src/i18n");
Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: previousWindow,
});

const entry: PluginCatalogEntry = {
	name: "@owner/example",
	description: '<script>alert("bad")</script>',
	author: "Alice",
	types: ["extension", "skill"],
	downloads: 1234,
	updatedAt: 1789708112206,
	url: "https://pi.dev/packages/%40owner/example",
};
const renderCard = (installed = false, busy = false) =>
	renderToStaticMarkup(
		createElement(I18nProvider, {
			children: createElement(PluginCatalogCard, {
				entry,
				installed,
				busy,
				onInstall: () => {},
				onOpen: () => {},
			}),
		}),
	);

describe("plugin overview UI", () => {
	test("shows package metadata and escapes remote content", () => {
		const html = renderCard();
		for (const text of [
			"@owner/example",
			"Alice",
			"扩展",
			"技能",
			"每月下载量",
			"安装",
			"在 pi.dev 查看",
		])
			expect(html).toContain(text);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	test("installed and busy packages cannot be installed again", () => {
		expect(renderCard(true)).toMatch(/disabled=""[^>]*>已安装/);
		expect(renderCard(false, true)).toMatch(/disabled=""[^>]*>安装/);
		expect(renderCard()).not.toContain('disabled=""');
	});

	test("settings opens the catalog and retains installed and manual entry points", () => {
		const html = renderToStaticMarkup(
			createElement(I18nProvider, { children: createElement(PluginSettings) }),
		);
		for (const text of [
			"插件概览",
			"已安装",
			"手动安装",
			"官方目录",
			"全部类型",
			"下载最多",
			"搜索名称",
		])
			expect(html).toContain(text);
		expect(html).not.toContain("npm:@scope/pkg");
		expect(html).not.toContain("没有插件注册表");
	});
});
