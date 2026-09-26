import { useState } from "react";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { AppearanceSettings } from "./AppearanceSettings";
import { AboutSettings } from "./AboutSettings";
import { GeneralSettings } from "./GeneralSettings";
import { ConnectSettings } from "./ConnectSettings";
import { GitHubSettings } from "./GitHubSettings";
import { ProviderModelSettings } from "./ProviderModelSettings";
import { PluginSettings } from "./PluginSettings";
import { McpSettings } from "./McpSettings";
import { AcpSettings } from "./AcpSettings";
import { TokenUsageSettings } from "./TokenUsageSettings";
import { SkillSettings } from "./SkillSettings";
import { WebUiSettings } from "./WebUiSettings";
import { ContextSettings } from "./ContextSettings";
import { HooksSettings } from "./HooksSettings";
import { api } from "../../api";
import { ArrowLeftIcon } from "../../lib/icons";

/**
 * In the order someone setting the app up meets them, grouped so the nav reads
 * as a few topics rather than one long list: the app itself, what it talks to
 * and what that costs, what the agent can do, what reaches in from outside.
 */
const SECTIONS = [
	{ id: "general", labelKey: "settings.section.general", group: "app" },
	{ id: "appearance", labelKey: "settings.section.appearance", group: "app" },
	{ id: "providers", labelKey: "settings.section.providers", group: "models" },
	{ id: "agents", labelKey: "settings.section.agents", group: "models" },
	{ id: "tokens", labelKey: "settings.section.tokens", group: "models" },
	{ id: "context", labelKey: "settings.section.context", group: "capabilities" },
	{ id: "skills", labelKey: "settings.section.skills", group: "capabilities" },
	{ id: "mcp", labelKey: "settings.section.mcp", group: "capabilities" },
	{ id: "plugins", labelKey: "settings.section.plugins", group: "capabilities" },
	{ id: "hooks", labelKey: "settings.section.hooks", group: "capabilities" },
	{ id: "github", labelKey: "settings.section.github", group: "integrations" },
	{ id: "connect", labelKey: "settings.section.connect", group: "integrations" },
	{ id: "webui", labelKey: "settings.section.webui", group: "integrations" },
	{ id: "about", labelKey: "settings.section.about", group: "about" },
] as const satisfies ReadonlyArray<{ id: string; labelKey: TranslationKey; group: string }>;

export type SettingsSectionId = (typeof SECTIONS)[number]["id"];
type SectionId = SettingsSectionId;

/**
 * Settings pages are a single reading column, but the token dashboard is a grid
 * of tiles over a 53-week calendar — at the shared width its weeks would scroll
 * sideways, which is the one thing a year-at-a-glance view cannot do.
 */
const SECTION_WIDTH: Partial<Record<SectionId, string>> = { tokens: "max-w-[58rem]" };

export function SettingsPage({
	onClose,
	initialSection,
	cwd = null,
	projects = [],
}: {
	onClose: () => void;
	initialSection?: SettingsSectionId;
	/** The project on screen, which the per-project sections open on. */
	cwd?: string | null;
	/** Every project the sidebar knows, for those sections' pickers. */
	projects?: readonly string[];
}) {
	const { t } = useTranslation();
	const [section, setSection] = useState<SectionId>(initialSection ?? "general");
	// External agents run local processes through the preload bridge.
	const sections =
		api.runtime === "web" ? SECTIONS.filter((entry) => entry.id !== "webui" && entry.id !== "agents") : SECTIONS;

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
				{sections.map((entry, index) => [
					// A hairline where the topic changes; filtered sections leave no empty group behind.
					index > 0 && sections[index - 1].group !== entry.group ? (
						<div key={`${entry.group}-divider`} className="mx-2 my-1 h-px bg-[color:var(--app-surface-divider)]" />
					) : null,
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
					</button>,
				])}
			</nav>

			<div className="min-h-0 flex-1 overflow-y-auto p-5">
				<div
					className={cn(
						"mx-auto flex w-full flex-col gap-4",
						SECTION_WIDTH[section] ?? "max-w-[42rem]",
					)}
				>
					<h2 className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
						{t(sections.find((entry) => entry.id === section)?.labelKey ?? "settings.title")}
					</h2>
					{section === "general" ? <GeneralSettings /> : null}
					{section === "connect" ? <ConnectSettings /> : null}
					{section === "appearance" ? <AppearanceSettings /> : null}
					{section === "providers" ? <ProviderModelSettings /> : null}
					{section === "agents" && api.runtime !== "web" ? <AcpSettings /> : null}
					{section === "tokens" ? <TokenUsageSettings /> : null}
					{section === "context" ? <ContextSettings cwd={cwd} projects={projects} /> : null}
					{section === "hooks" ? <HooksSettings projects={projects} /> : null}
					{section === "skills" ? <SkillSettings /> : null}
					{section === "plugins" ? <PluginSettings /> : null}
					{section === "mcp" ? <McpSettings /> : null}
					{section === "github" ? <GitHubSettings /> : null}
					{section === "webui" && api.runtime !== "web" ? <WebUiSettings /> : null}
					{section === "about" ? <AboutSettings /> : null}
				</div>
			</div>
		</div>
	);
}
