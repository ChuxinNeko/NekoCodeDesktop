import { useState } from "react";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { AppearanceSettings } from "./AppearanceSettings";
import { AboutSettings } from "./AboutSettings";
import { GeneralSettings } from "./GeneralSettings";
import { ConnectSettings } from "./ConnectSettings";
import { GitHubSettings } from "./GitHubSettings";
import { SshSettings } from "./SshSettings";
import { ProviderModelSettings } from "./ProviderModelSettings";
import { PluginSettings } from "./PluginSettings";
import { McpSettings } from "./McpSettings";
import { AcpSettings } from "./AcpSettings";
import { TeamSettings } from "./TeamSettings";
import { TokenUsageSettings } from "./TokenUsageSettings";
import { SkillSettings } from "./SkillSettings";
import { WebUiSettings } from "./WebUiSettings";
import { ContextSettings } from "./ContextSettings";
import { HooksSettings } from "./HooksSettings";
import { WebToolsSettings } from "./WebToolsSettings";
import { CodeIntelSettings } from "./CodeIntelSettings";
import { PromptSettings } from "./PromptSettings";
import { api } from "../../api";
import { ArrowLeftIcon } from "../../lib/icons";
import { SettingsSurfaceContext } from "../../lib/settingsSurface";

/**
 * What you open settings to change, then how the agent behaves, then the
 * optional pieces. Usage and about sit last: they are looked up, not configured
 * in the same pass as a model or a prompt.
 */
const GROUPS = [
	{ id: "essentials", labelKey: "settings.group.essentials" },
	{ id: "agent", labelKey: "settings.group.agent" },
	{ id: "extensions", labelKey: "settings.group.extensions" },
	{ id: "connections", labelKey: "settings.group.connections" },
	{ id: "other", labelKey: "settings.group.other" },
] as const satisfies ReadonlyArray<{ id: string; labelKey: TranslationKey }>;

const SECTIONS = [
	{ id: "providers", labelKey: "settings.section.providers", group: "essentials" },
	{ id: "general", labelKey: "settings.section.general", group: "essentials" },
	{ id: "appearance", labelKey: "settings.section.appearance", group: "essentials" },
	{ id: "prompts", labelKey: "settings.section.prompts", group: "agent" },
	{ id: "context", labelKey: "settings.section.context", group: "agent" },
	{ id: "skills", labelKey: "settings.section.skills", group: "agent" },
	{ id: "web", labelKey: "settings.section.web", group: "agent" },
	{ id: "codeIntel", labelKey: "settings.section.codeIntel", group: "agent" },
	{ id: "mcp", labelKey: "settings.section.mcp", group: "extensions" },
	{ id: "plugins", labelKey: "settings.section.plugins", group: "extensions" },
	{ id: "hooks", labelKey: "settings.section.hooks", group: "extensions" },
	{ id: "team", labelKey: "settings.section.team", group: "extensions" },
	{ id: "agents", labelKey: "settings.section.agents", group: "extensions" },
	{ id: "github", labelKey: "settings.section.github", group: "connections" },
	{ id: "ssh", labelKey: "settings.section.ssh", group: "connections" },
	{ id: "connect", labelKey: "settings.section.connect", group: "connections" },
	{ id: "webui", labelKey: "settings.section.webui", group: "connections" },
	{ id: "tokens", labelKey: "settings.section.tokens", group: "other" },
	{ id: "about", labelKey: "settings.section.about", group: "other" },
] as const satisfies ReadonlyArray<{ id: string; labelKey: TranslationKey; group: (typeof GROUPS)[number]["id"] }>;

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
	// External agents run local processes through the preload bridge; SSH
	// passwords are entered on the desktop, not over the network.
	const sections =
		api.runtime === "web"
			? SECTIONS.filter((entry) => entry.id !== "webui" && entry.id !== "agents" && entry.id !== "ssh" && entry.id !== "codeIntel")
			: SECTIONS;

	const groups = GROUPS.map((group) => ({
		...group,
		entries: sections.filter((entry) => entry.group === group.id),
	})).filter((group) => group.entries.length > 0);

	return (
		<SettingsSurfaceContext.Provider value={true}>
			<div className="flex min-h-0 min-w-0 flex-1">
				<nav className="flex w-36 shrink-0 flex-col border-r border-[color:var(--app-surface-divider)] min-[1100px]:w-52">
					<div className="flex shrink-0 items-center gap-1 px-3 pb-2 pt-2">
						<Button onClick={onClose} size="icon-xs" variant="ghost">
							<ArrowLeftIcon className="size-3.5" />
						</Button>
						<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">
							{t("settings.title")}
						</span>
					</div>
					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-3">
						{groups.map((group) => (
							<div key={group.id} className="flex flex-col gap-0.5">
								<div className="px-2 pb-0.5 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground">
									{t(group.labelKey)}
								</div>
								{group.entries.map((entry) => (
									<button
										key={entry.id}
										type="button"
										aria-current={section === entry.id ? "page" : undefined}
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
							</div>
						))}
					</div>
				</nav>

				{/* Keep navigation outside the glass scope; only settings controls
				    in the content column and their portalled popups use it. */}
				<div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3 min-[1100px]:p-5" data-settings-surface="page">
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
						{section === "team" ? <TeamSettings /> : null}
						{section === "tokens" ? <TokenUsageSettings /> : null}
						{section === "prompts" ? <PromptSettings /> : null}
						{section === "context" ? <ContextSettings cwd={cwd} projects={projects} /> : null}
						{section === "hooks" ? <HooksSettings projects={projects} /> : null}
						{section === "web" ? <WebToolsSettings /> : null}
						{section === "codeIntel" && api.runtime !== "web" ? <CodeIntelSettings cwd={cwd} onOpenProviders={() => setSection("providers")} /> : null}
						{section === "skills" ? <SkillSettings /> : null}
						{section === "plugins" ? <PluginSettings /> : null}
						{section === "mcp" ? <McpSettings /> : null}
						{section === "github" ? <GitHubSettings /> : null}
						{section === "ssh" && api.runtime !== "web" ? <SshSettings /> : null}
						{section === "webui" && api.runtime !== "web" ? <WebUiSettings /> : null}
						{section === "about" ? <AboutSettings /> : null}
					</div>
				</div>
			</div>
		</SettingsSurfaceContext.Provider>
	);
}
