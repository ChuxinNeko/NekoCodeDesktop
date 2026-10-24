import type { TranslateFn, TranslationKey } from "../i18n";
import { en } from "../i18n/locales/en";
import { zhCN } from "../i18n/locales/zh-CN";
import { SHORTCUTS } from "./shortcuts";

/** Search only UI copy, never saved configuration values or credentials. */
const PREFIXES = {
	providers: ["providers.", "models.", "oauth.", "acpModels.", "acpProviders."],
	general: [],
	shortcuts: ["shortcuts."],
	appearance: ["settings.", "layout."],
	prompts: ["prompts."],
	context: ["context."],
	skills: ["skills."],
	web: ["webTools."],
	codeIntel: ["codeIntel."],
	mcp: ["mcp."],
	plugins: ["plugins."],
	hooks: ["hooks."],
	team: ["team."],
	agents: ["acpSettings."],
	github: ["github."],
	ssh: ["ssh."],
	connect: ["connect.", "mobile.", "qqbot."],
	webui: ["webui."],
	tokens: ["tokens."],
	about: ["updates."],
} satisfies Record<string, string[]>;

export type SearchableSettingsSection = keyof typeof PREFIXES;

const GENERAL_KEYS = [
	"settings.closeBehavior",
	"settings.commandShell", "settings.language", "settings.autoRetryCount",
	"settings.notifyOnTaskFinish", "settings.isolateBackground", "settings.computerUse", "settings.proxy",
] as const;

const keys = Object.keys(en) as TranslationKey[];
const generalKey = (key: string) => GENERAL_KEYS.some((base) => key.startsWith(base));
const index = Object.fromEntries(Object.entries(PREFIXES).map(([section, prefixes]) => [section,
	keys.filter((key) => section === "general" ? generalKey(key)
		: prefixes.some((prefix) => key.startsWith(prefix)) &&
			(section !== "appearance" || (!generalKey(key) && !key.startsWith("settings.section.") && !key.startsWith("settings.group.") && !key.startsWith("settings.search") && key !== "settings.title"))),
])) as Record<SearchableSettingsSection, TranslationKey[]>;
index.shortcuts = [...new Set([...index.shortcuts, ...SHORTCUTS.map((command) => command.labelKey)])];

const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().trim();

/** Keeps navigation order and respects the caller's desktop/web section visibility. */
export function searchSettings<T extends { id: SearchableSettingsSection; labelKey: TranslationKey }>(
	sections: readonly T[], query: string, t: TranslateFn,
): Array<{ section: T; match: string | null; matchKey?: TranslationKey }> {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	if (!words.length) return sections.map((section) => ({ section, match: null }));
	return sections.flatMap<{ section: T; match: string | null; matchKey?: TranslationKey }>((section) => {
		const title = normalize(`${t(section.labelKey)} ${en[section.labelKey]} ${zhCN[section.labelKey]}`);
		if (words.every((word) => title.includes(word))) return [{ section, match: null }];
		const matches = index[section.id].filter((key) => {
			const text = normalize(`${title} ${t(key)} ${en[key]} ${zhCN[key]}`);
			return words.every((word) => text.includes(word));
		});
		// Prefer a concise setting label over a long explanation when both match.
		matches.sort((a, b) => t(a).length - t(b).length);
		const key = matches[0];
		return key ? [{ section, match: t(key).replace(/\{\w+\}/g, "…"), matchKey: key }] : [];
	});
}
