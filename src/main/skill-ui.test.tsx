import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SkillSummary, SkillsSnapshot } from "../shared/skills";

// Same bridge stand-in as the other renderer tests: importing a settings panel
// must not reach for Electron's preload API.
const previousWindow = globalThis.window;
Object.defineProperty(globalThis, "window", { configurable: true, value: { nekocode: {} } });
const { SkillSettingsView } = await import("../renderer/src/components/settings/SkillSettings");
const { I18nProvider } = await import("../renderer/src/i18n");
Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });

function skill(patch: Partial<SkillSummary> = {}): SkillSummary {
	return {
		name: "code-review",
		description: "审查代码改动",
		path: "/app/resources/skills/code-review/SKILL.md",
		origin: "builtin",
		enabled: true,
		...patch,
	};
}

function snapshot(patch: Partial<SkillsSnapshot> = {}): SkillsSnapshot {
	return {
		builtin: [skill(), skill({ name: "write-tests", description: "补测试", enabled: false })],
		active: [skill()],
		directories: { user: "/home/me/.nekocode/agent/skills", project: "/work/app/.nekocode/skills" },
		warnings: [],
		...patch,
	};
}

const render = (value: SkillsSnapshot | null) =>
	renderToStaticMarkup(
		createElement(I18nProvider, {
			children: createElement(SkillSettingsView, { snapshot: value, onToggle: () => {} }),
		}),
	);

describe("SkillSettingsView", () => {
	test("lists every built-in skill with its description and file", () => {
		const markup = render(snapshot());
		expect(markup).toContain("code-review");
		expect(markup).toContain("审查代码改动");
		expect(markup).toContain("/app/resources/skills/code-review/SKILL.md");
	});

	test("a switched-off skill reads as off rather than disappearing", () => {
		const markup = render(snapshot());
		// It has to stay on screen — an absent row would look like a missing skill
		// rather than one the user turned off.
		expect(markup).toContain("write-tests");
		expect(markup).toContain('data-checked=""');
		expect(markup).toContain('data-unchecked=""');
	});

	test("skills the user brought themselves are listed apart from the built-ins", () => {
		const mine = skill({
			name: "deploy",
			description: "发布流程",
			path: "/home/me/.nekocode/agent/skills/deploy/SKILL.md",
			origin: "user",
		});
		const markup = render(snapshot({ active: [skill(), mine] }));
		expect(markup).toContain("deploy");
		expect(markup).toContain("/home/me/.nekocode/agent/skills/deploy/SKILL.md");
		// Two built-in rows and one of the user's — the built-in that the session
		// also loaded is not repeated in the discovered section.
		const count = (needle: string) => markup.split(`>${needle}<`).length - 1;
		expect(count("内置")).toBe(2);
		expect(count("用户")).toBe(1);
	});

	test("names both directories a skill can be dropped into", () => {
		const markup = render(snapshot());
		expect(markup).toContain("/home/me/.nekocode/agent/skills");
		expect(markup).toContain("/work/app/.nekocode/skills");
	});

	test("without a project it says so instead of showing an empty list", () => {
		const markup = render(snapshot({ active: [], directories: { user: "/u/skills", project: null } }));
		expect(markup).toContain("（未打开项目）");
	});

	test("no session at all asks for a project rather than claiming there are none", () => {
		const markup = render(null);
		expect(markup).toContain("打开一个项目后");
		expect(markup).toContain("当前安装没有内置技能");
	});

	test("loader warnings are surfaced, not swallowed", () => {
		const markup = render(snapshot({ warnings: ['name "code-review" collision — /a/SKILL.md'] }));
		expect(markup).toContain("collision");
		expect(markup).toContain("加载告警");
	});
});
