import { useMemo, useState } from "react";
import { useTheme } from "../../hooks/useTheme";
import { getAvailableCodeThemes, type ThemeMode, type ThemeVariant } from "../../theme/theme.logic";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { COMPOSER_PICKER_MENU_OPTION_CLASS_NAME, COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "../chat/composerPickerStyles";
import { ChevronDownIcon } from "../../lib/icons";

const MODES: { id: ThemeMode; label: string }[] = [
	{ id: "light", label: "Light" },
	{ id: "dark", label: "Dark" },
	{ id: "system", label: "System" },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-4 py-2.5">
			<div className="flex min-w-0 flex-col">
				<span className="text-[length:var(--app-font-size-ui,12px)]">{label}</span>
				{hint ? (
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{hint}
					</span>
				) : null}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

export function AppearanceSettings() {
	const {
		theme,
		resolvedTheme,
		setTheme,
		themeState,
		setCodeThemeId,
		systemUiFont,
		setSystemUiFont,
		resetAllThemes,
	} = useTheme();
	const codeThemes = useMemo(() => getAvailableCodeThemes(resolvedTheme), [resolvedTheme]);
	const activeCodeThemeId = themeState.codeThemeIds[resolvedTheme as ThemeVariant];
	const [menuOpen, setMenuOpen] = useState(false);

	return (
		<section className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
			<Row hint="Follows the OS when set to system." label="Theme mode">
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
							{entry.label}
						</button>
					))}
				</div>
			</Row>

			<Row hint={`Applies to the ${resolvedTheme} variant.`} label="Code theme">
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
						<MenuGroupLabel>Code theme</MenuGroupLabel>
						<MenuRadioGroup
							value={activeCodeThemeId}
							onValueChange={(value) => {
								setCodeThemeId(resolvedTheme as ThemeVariant, value);
								setMenuOpen(false);
							}}
						>
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
			</Row>

			<Row hint="Use the OS UI font instead of the bundled stack." label="System UI font">
				<Button
					onClick={() => setSystemUiFont(!systemUiFont)}
					size="sm"
					variant={systemUiFont ? "subtle" : "chrome-outline"}
				>
					{systemUiFont ? "On" : "Off"}
				</Button>
			</Row>

			<Row hint="Restore both variants to the Codex default pack." label="Reset appearance">
				<Button onClick={resetAllThemes} size="sm" variant="chrome-outline">
					Reset
				</Button>
			</Row>
		</section>
	);
}
