import { useState } from "react";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { AppearanceSettings } from "./AppearanceSettings";
import { GeneralSettings } from "./GeneralSettings";
import { GitHubSettings } from "./GitHubSettings";
import { ModelSettings } from "./ModelSettings";
import { ArrowLeftIcon } from "../../lib/icons";

const SECTIONS = [
	{ id: "general", labelKey: "settings.section.general" },
	{ id: "appearance", labelKey: "settings.section.appearance" },
	{ id: "models", labelKey: "settings.section.models" },
	{ id: "github", labelKey: "settings.section.github" },
	{ id: "about", labelKey: "settings.section.about" },
] as const satisfies ReadonlyArray<{ id: string; labelKey: TranslationKey }>;

type SectionId = (typeof SECTIONS)[number]["id"];

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
				<div className="mx-auto flex w-full max-w-[42rem] flex-col gap-4">
					<h2 className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
						{t(SECTIONS.find((entry) => entry.id === section)?.labelKey ?? "settings.title")}
					</h2>
					{section === "general" ? <GeneralSettings /> : null}
					{section === "appearance" ? <AppearanceSettings /> : null}
					{section === "models" ? <ModelSettings /> : null}
					{section === "github" ? <GitHubSettings /> : null}
					{section === "about" ? (
						<div className="flex flex-col gap-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							<p>{t("settings.about.p1")}</p>
							<p>
								{t("settings.about.p2a")} <code>vendor/pi</code> {t("settings.about.p2b")}{" "}
								<code>bun run pi:setup</code>
								{t("settings.about.p2c")}
							</p>
							<p>{t("settings.about.p3")}</p>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
