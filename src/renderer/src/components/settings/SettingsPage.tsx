import { useEffect, useMemo, useRef, useState } from "react";
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
import { ShortcutSettings } from "./ShortcutSettings";
import { api } from "../../api";
import { ArrowLeftIcon, SearchIcon, XIcon } from "../../lib/icons";
import { searchSettings } from "../../lib/settingsSearch";
import { findSettingsSearchTarget, revealSettingsSearchTarget } from "../../lib/settingsSearchTarget";
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
	{ id: "shortcuts", labelKey: "settings.section.shortcuts", group: "essentials" },
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
	onOpenTeam,
}: {
	onClose: () => void;
	initialSection?: SettingsSectionId;
	/** The project on screen, which the per-project sections open on. */
	cwd?: string | null;
	/** Every project the sidebar knows, for those sections' pickers. */
	projects?: readonly string[];
	onOpenTeam?: () => void;
}) {
	const { t } = useTranslation();
	const [section, setSection] = useState<SectionId>(initialSection ?? "general");
	const [query, setQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const [navigation, setNavigation] = useState<{ id: SectionId; key?: TranslationKey } | null>(null);
	// External agents run local processes through the preload bridge; SSH
	// passwords are entered on the desktop, not over the network.
	const sections =
		api.runtime === "web"
			? SECTIONS.filter((entry) => entry.id !== "webui" && entry.id !== "agents" && entry.id !== "ssh" && entry.id !== "codeIntel")
			: SECTIONS;

	const results = useMemo(() => searchSettings(sections, query, t), [sections, query, t]);
	const matches = new Map(results.map((result) => [result.section.id, result.match]));
	const searching = query.trim().length > 0;
	const openSection = (id: SectionId) => {
		setSection(id);
		setNavigation({ id, key: results.find((result) => result.section.id === id)?.matchKey });
	};
	useEffect(() => {
		const root = contentRef.current;
		if (!root || !navigation) return;
		root.scrollTo({ top: 0, behavior: "instant" });
		if (!navigation.key) return;
		const key = navigation.key;
		let frame = 0;
		const reveal = () => {
			const target = findSettingsSearchTarget(root, key, t);
			if (!target) return;
			revealSettingsSearchTarget(root, target);
			observer.disconnect();
		};
		// Several settings pages load their controls asynchronously. Wait for the
		// actual row instead of scrolling the old page before React commits.
		const observer = new MutationObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(reveal);
		});
		observer.observe(root, { childList: true, subtree: true, characterData: true });
		frame = requestAnimationFrame(reveal);
		const timeout = setTimeout(() => observer.disconnect(), 15_000);
		return () => { clearTimeout(timeout); cancelAnimationFrame(frame); observer.disconnect(); };
	}, [navigation, t]);
	const groups = GROUPS.map((group) => ({
		...group,
		entries: sections.filter((entry) => entry.group === group.id && matches.has(entry.id)),
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
					<div className="relative mx-2 mb-3 shrink-0">
						<SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
							aria-label={t("settings.search")} placeholder={t("settings.search")}
							className="w-full rounded-md border border-border bg-transparent py-1.5 pl-7 pr-7 text-[length:var(--app-font-size-ui-sm,11px)] outline-none placeholder:text-muted-foreground focus:border-[color:var(--color-border-focus)] [&::-webkit-search-cancel-button]:appearance-none"
							onKeyDown={(event) => {
								if (event.nativeEvent.isComposing) return;
								if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setQuery(""); }
								if (event.key === "Enter" && results[0]) { event.preventDefault(); openSection(results[0].section.id); }
							}}
						/>
						{query ? <Button size="icon-xs" variant="ghost" aria-label={t("settings.searchClear")} className="absolute right-0.5 top-1/2 -translate-y-1/2"
							onClick={() => { setQuery(""); searchRef.current?.focus(); }}><XIcon className="size-3" /></Button> : null}
					</div>
					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-3">
						{searching ? <p role="status" className="px-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
							{t(results.length ? "settings.searchCount" : "settings.searchEmpty", { count: results.length })}
						</p> : null}
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
										onClick={() => openSection(entry.id)}
										title={matches.get(entry.id) ?? t(entry.labelKey)}
										className={cn(
											"flex min-h-[var(--app-density-row-height,1.75rem)] flex-col items-start justify-center rounded-md px-2 py-1 text-left text-[length:var(--app-font-size-ui,12px)] transition-colors",
											section === entry.id
												? "bg-[var(--sidebar-selected)] text-foreground"
												: "text-foreground/95 hover:bg-[var(--sidebar-accent)]",
										)}
									>
										{t(entry.labelKey)}
										{matches.get(entry.id) ? <span className="line-clamp-2 break-words text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{matches.get(entry.id)}</span> : null}
									</button>
								))}
							</div>
						))}
					</div>
				</nav>

				{/* Keep navigation outside the glass scope; only settings controls
				    in the content column and their portalled popups use it. */}
				<div ref={contentRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3 min-[1100px]:p-5" data-settings-surface="page">
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
						{section === "shortcuts" ? <ShortcutSettings /> : null}
						{section === "connect" ? <ConnectSettings searchTarget={navigation?.id === "connect" ? navigation.key : undefined} /> : null}
						{section === "appearance" ? <AppearanceSettings /> : null}
						{section === "providers" ? <ProviderModelSettings searchTarget={navigation?.id === "providers" ? navigation.key : undefined} /> : null}
						{section === "agents" && api.runtime !== "web" ? <AcpSettings /> : null}
						{section === "team" ? <TeamSettings onOpenOverview={onOpenTeam} /> : null}
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
