import { LANGUAGE_OPTIONS, useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { SettingsRow } from "./SettingsRow";

export function GeneralSettings() {
	const { language, setLanguage, t } = useTranslation();

	return (
		<section className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
			<SettingsRow hint={t("settings.languageHint")} label={t("settings.language")}>
				<div className="flex items-center gap-1 rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
					{LANGUAGE_OPTIONS.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => setLanguage(entry.id)}
							className={cn(
								"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
								language === entry.id
									? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{entry.label}
						</button>
					))}
				</div>
			</SettingsRow>
		</section>
	);
}
