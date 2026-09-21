import { useState } from "react";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { AppearanceSettings } from "./AppearanceSettings";
import { AboutSettings } from "./AboutSettings";
import { GeneralSettings } from "./GeneralSettings";
import { MobileSettings } from "./MobileSettings";
import { GitHubSettings } from "./GitHubSettings";
import { ProviderModelSettings } from "./ProviderModelSettings";
import { PluginSettings } from "./PluginSettings";
import { TokenUsageSettings } from "./TokenUsageSettings";
import { SkillSettings } from "./SkillSettings";
import { ArrowLeftIcon } from "../../lib/icons";

const SECTIONS = [
	{ id: "general", labelKey: "settings.section.general" },
	{ id: "mobile", labelKey: "settings.section.mobile" },
	{ id: "appearance", labelKey: "settings.section.appearance" },
	{ id: "providers", labelKey: "settings.section.providers" },
	{ id: "tokens", labelKey: "settings.section.tokens" },
	{ id: "skills", labelKey: "settings.section.skills" },
	{ id: "plugins", labelKey: "settings.section.plugins" },
	{ id: "github", labelKey: "settings.section.github" },
	{ id: "about", labelKey: "settings.section.about" },
] as const satisfies ReadonlyArray<{ id: string; labelKey: TranslationKey }>;

type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * Settings pages are a single reading column, but the token dashboard is a grid
 * of tiles over a 53-week calendar — at the shared width its weeks would scroll
 * sideways, which is the one thing a year-at-a-glance view cannot do.
 */
const SECTION_WIDTH: Partial<Record<SectionId, string>> = { tokens: "max-w-[58rem]" };

export function SettingsPage({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation();
	const [section, setSection] = useState<SectionId>("general");

	return (
		<div className="flex min-h-0 flex-1">
			<nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-[color:var(--app-surface-divider)] p-2">
				<div className="flex items-center gap-1 px-1 pb-2">
					<Button onClick={onClose} size="icon-xs" variant="ghost">
						<ArrowLeftIcon className="size-3.5" />
					</Button>
					<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">
						{t("settings.title")}
					</span>
				</div>
				{SECTIONS.map((entry) => (
					<button
						key={entry.id}
						type="button"
						onClick={() => setSection(entry.id)}
						className={cn(
							"flex h-[var(--app-density-row-height,1.75rem)] items-center rounded-md px-2 text-left text-[length:var(--app-font-size-ui,12px)] transition-colors",
							section === entry.id
								? "bg-[var(--sidebar-selected)] text-foreground"
								: "text-foreground/95 hover:bg-[var(--sidebar-accent)]",
						)}
					>
						{t(entry.labelKey)}
					</button>
				))}
			</nav>

			<div className="min-h-0 flex-1 overflow-y-auto p-5">
				<div
					className={cn(
						"mx-auto flex w-full flex-col gap-4",
						SECTION_WIDTH[section] ?? "max-w-[42rem]",
					)}
				>
					<h2 className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
						{t(SECTIONS.find((entry) => entry.id === section)?.labelKey ?? "settings.title")}
					</h2>
					{section === "general" ? <GeneralSettings /> : null}
					{section === "mobile" ? <MobileSettings /> : null}
					{section === "appearance" ? <AppearanceSettings /> : null}
					{section === "providers" ? <ProviderModelSettings /> : null}
					{section === "tokens" ? <TokenUsageSettings /> : null}
					{section === "skills" ? <SkillSettings /> : null}
					{section === "plugins" ? <PluginSettings /> : null}
					{section === "github" ? <GitHubSettings /> : null}
					{section === "about" ? <AboutSettings /> : null}
				</div>
			</div>
		</div>
	);
}
