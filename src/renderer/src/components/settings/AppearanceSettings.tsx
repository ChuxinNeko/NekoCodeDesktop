import { useMemo, useState } from "react";
import { useTheme } from "../../hooks/useTheme";
import { useTranslation, type TranslationKey } from "../../i18n";
import { getAvailableCodeThemes, type ThemeMode, type ThemeVariant } from "../../theme/theme.logic";
import { WINDOW_MATERIALS, type WindowMaterial } from "../../../../shared/window";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { COMPOSER_PICKER_MENU_OPTION_CLASS_NAME, COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "../chat/composerPickerStyles";
import { ChevronDownIcon } from "../../lib/icons";
import { SettingsRow } from "./SettingsRow";

const MODES: { id: ThemeMode; labelKey: TranslationKey }[] = [
	{ id: "light", labelKey: "theme.light" },
	{ id: "dark", labelKey: "theme.dark" },
	{ id: "system", labelKey: "theme.system" },
];

const MATERIAL_LABEL_KEYS: Record<WindowMaterial, TranslationKey> = {
	opaque: "settings.windowMaterial.opaque",
	mica: "settings.windowMaterial.mica",
	acrylic: "settings.windowMaterial.acrylic",
};

export function AppearanceSettings() {
	const { t } = useTranslation();
	const {
		theme,
		resolvedTheme,
		setTheme,
		themeState,
		setCodeThemeId,
		systemUiFont,
		setSystemUiFont,
		windowMaterial,
		setWindowMaterial,
		supportedWindowMaterials,
		resetAllThemes,
	} = useTheme();
	const codeThemes = useMemo(() => getAvailableCodeThemes(resolvedTheme), [resolvedTheme]);
	const activeCodeThemeId = themeState.codeThemeIds[resolvedTheme as ThemeVariant];
	const [menuOpen, setMenuOpen] = useState(false);
	const [materialMenuOpen, setMaterialMenuOpen] = useState(false);
	// Windows before 11 22H2 (and every other platform) can only paint the opaque
	// shell; the rest stay listed but unpickable, so the setting explains itself
	// instead of silently vanishing.
	const hasBackdrops = supportedWindowMaterials.length > 1;

	return (
		<section className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
			<SettingsRow hint={t("settings.themeModeHint")} label={t("settings.themeMode")}>
				<div className="flex items-center gap-1 rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
					{MODES.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => setTheme(entry.id)}
							className={cn(
								"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
								theme === entry.id
									? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{t(entry.labelKey)}
						</button>
					))}
				</div>
			</SettingsRow>

			<SettingsRow
				hint={t("settings.codeThemeHint", {
					variant: t(resolvedTheme === "dark" ? "theme.dark" : "theme.light"),
				})}
				label={t("settings.codeTheme")}
			>
				<Menu open={menuOpen} onOpenChange={setMenuOpen}>
					<MenuTrigger
						render={
							<Button
								className={cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "border-transparent")}
								size="chip"
								variant="ghost"
							>
								<span className="truncate">
									{codeThemes.find((option) => option.id === activeCodeThemeId)?.label ??
										activeCodeThemeId}
								</span>
								<ChevronDownIcon className="size-3 opacity-60" />
							</Button>
						}
					/>
					<ComposerPickerMenuPopup align="end" side="bottom">
						{/* Inside the radio group, not beside it: Base UI takes the group
						    context from MenuRadioGroup, and a label outside one throws as
						    soon as the menu opens. */}
						<MenuRadioGroup
							value={activeCodeThemeId}
							onValueChange={(value) => {
								setCodeThemeId(resolvedTheme as ThemeVariant, value);
								setMenuOpen(false);
							}}
						>
							<MenuGroupLabel>{t("settings.codeTheme")}</MenuGroupLabel>
							{codeThemes.map((option) => (
								<MenuRadioItem
									key={option.id}
									className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
									value={option.id}
								>
									{option.label}
								</MenuRadioItem>
							))}
						</MenuRadioGroup>
					</ComposerPickerMenuPopup>
				</Menu>
			</SettingsRow>

			<SettingsRow
				hint={
					hasBackdrops ? t("settings.windowMaterialHint") : t("settings.windowMaterialUnsupported")
				}
				label={t("settings.windowMaterial")}
			>
				<Menu open={materialMenuOpen} onOpenChange={setMaterialMenuOpen}>
					<MenuTrigger
						render={
							<Button
								className={cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "border-transparent")}
								size="chip"
								variant="ghost"
							>
								<span className="truncate">{t(MATERIAL_LABEL_KEYS[windowMaterial])}</span>
								<ChevronDownIcon className="size-3 opacity-60" />
							</Button>
						}
					/>
					<ComposerPickerMenuPopup align="end" side="bottom">
						<MenuRadioGroup
							value={windowMaterial}
							onValueChange={(value) => {
								void setWindowMaterial(value as WindowMaterial);
								setMaterialMenuOpen(false);
							}}
						>
							<MenuGroupLabel>{t("settings.windowMaterial")}</MenuGroupLabel>
							{WINDOW_MATERIALS.map((material) => (
								<MenuRadioItem
									key={material}
									className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
									disabled={!supportedWindowMaterials.includes(material)}
									value={material}
								>
									{t(MATERIAL_LABEL_KEYS[material])}
								</MenuRadioItem>
							))}
						</MenuRadioGroup>
					</ComposerPickerMenuPopup>
				</Menu>
			</SettingsRow>

			<SettingsRow hint={t("settings.systemUiFontHint")} label={t("settings.systemUiFont")}>
				<Button
					onClick={() => setSystemUiFont(!systemUiFont)}
					size="sm"
					variant={systemUiFont ? "subtle" : "chrome-outline"}
				>
					{systemUiFont ? t("common.on") : t("common.off")}
				</Button>
			</SettingsRow>

			<SettingsRow hint={t("settings.resetAppearanceHint")} label={t("settings.resetAppearance")}>
				<Button onClick={resetAllThemes} size="sm" variant="chrome-outline">
					{t("common.reset")}
				</Button>
			</SettingsRow>
		</section>
	);
}
