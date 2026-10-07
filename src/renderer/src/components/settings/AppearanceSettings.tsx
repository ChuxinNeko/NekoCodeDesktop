import { useMemo, useRef, useState } from "react";
import { applyCommunityThemeNow, useTheme } from "../../hooks/useTheme";
import { installThemePackage, removeCommunityTheme, useThemeLibrary } from "../../hooks/useThemeLibrary";
import { api, errorMessage } from "../../api";
import { MAX_THEME_PACKAGE_BYTES, THEME_PACKAGE_EXTENSION, parseThemePackage, type CommunityTheme } from "../../../../shared/themes";
import { useAppearancePreferences } from "../../hooks/useAppearancePreferences";
import { useTranslation, type TranslationKey } from "../../i18n";
import { getAvailableCodeThemes, parseThemeShareString, type ThemeMode, type ThemeSharePayload, type ThemeVariant } from "../../theme/theme.logic";
import { WINDOW_MATERIALS, type WindowMaterial } from "../../../../shared/window";
import { UI_DENSITY_MODES, type UiDensity } from "../../lib/appDensity";
import { CHAT_WIDTH_MODES, type ChatWidthMode } from "../../lib/chatWidth";
import { getAppTypographyScale } from "../../lib/appTypography";
import {
	DEFAULT_APPEARANCE_PREFERENCES,
	FONT_SIZE_RANGE,
	MONO_FONT_SIZE_RANGE,
} from "../../lib/appearancePreferences";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Menu, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { COMPOSER_PICKER_MENU_OPTION_CLASS_NAME, COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "../chat/composerPickerStyles";
import { CheckIcon, ChevronDownIcon, CopyIcon, MinusIcon, PlusIcon, RotateCcwIcon, XIcon } from "../../lib/icons";
import { FontFamilyPicker } from "./FontFamilyPicker";
import { SETTINGS_TEXTAREA_CLASS_NAME, SettingsDialog } from "./SettingsDialog";
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

const DENSITY_LABEL_KEYS: Record<UiDensity, TranslationKey> = {
	compact: "settings.density.compact",
	comfortable: "settings.density.comfortable",
	spacious: "settings.density.spacious",
};

const CHAT_WIDTH_LABEL_KEYS: Record<ChatWidthMode, TranslationKey> = {
	standard: "settings.chatWidth.standard",
	wide: "settings.chatWidth.wide",
	full: "settings.chatWidth.full",
};

const ACCENT_PRESETS = ["#339cff", "#6e56cf", "#d6409f", "#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594"];

const PREVIEW_TEXT = "The quick brown fox 敏捷的狐狸 0O 1lI => !=";

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col">
			<h3 className="pb-1 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground">
				{title}
			</h3>
			<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">{children}</div>
		</section>
	);
}

function SegmentedControl<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: readonly { id: T; label: string }[];
	onChange: (value: T) => void;
}) {
	return (
		<div className="flex items-center gap-1 rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
			{options.map((entry) => (
				<button
					key={entry.id}
					type="button"
					onClick={() => onChange(entry.id)}
					className={cn(
						"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
						value === entry.id
							? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{entry.label}
				</button>
			))}
		</div>
	);
}

/** − 13px + with a reset arrow once the value leaves its default. */
function SizeStepper({
	value,
	min,
	max,
	onChange,
	onReset,
	label,
}: {
	value: number;
	min: number;
	max: number;
	onChange: (value: number) => void;
	/** Shown only when set — i.e. when the value differs from its default. */
	onReset?: () => void;
	label?: string;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex items-center gap-1">
			{/* Always laid out, so the steppers line up whether or not a row is at its default. */}
			<Button
				aria-hidden={!onReset}
				aria-label={t("common.reset")}
				className={cn(!onReset && "invisible")}
				onClick={onReset}
				size="icon-chip"
				title={t("common.reset")}
				variant="ghost"
			>
				<RotateCcwIcon />
			</Button>
			<Button aria-label="-" disabled={value <= min} onClick={() => onChange(value - 1)} size="icon-chip" variant="ghost">
				<MinusIcon />
			</Button>
			<span className="min-w-14 text-center text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums">
				{label ?? `${value}px`}
			</span>
			<Button aria-label="+" disabled={value >= max} onClick={() => onChange(value + 1)} size="icon-chip" variant="ghost">
				<PlusIcon />
			</Button>
		</div>
	);
}

function ClearFontButton({ visible, onClear }: { visible: boolean; onClear: () => void }) {
	const { t } = useTranslation();
	return (
		<Button
			aria-hidden={!visible}
			aria-label={t("common.clear")}
			className={cn(!visible && "invisible")}
			onClick={onClear}
			size="icon-chip"
			title={t("common.clear")}
			variant="ghost"
		>
			<XIcon />
		</Button>
	);
}

function AccentPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const { t } = useTranslation();
	const isPreset = ACCENT_PRESETS.includes(value);
	return (
		<div className="flex items-center gap-1.5">
			{ACCENT_PRESETS.map((color) => (
				<button
					key={color}
					aria-label={color}
					className="flex size-5 items-center justify-center rounded-full ring-offset-2 ring-offset-[var(--app-settings-surface)] transition-transform hover:scale-110 data-[active=true]:ring-2 data-[active=true]:ring-[color:var(--color-border-heavy)]"
					data-active={value === color}
					onClick={() => onChange(color)}
					style={{ backgroundColor: color }}
					type="button"
				>
					{value === color ? <CheckIcon className="size-3 text-white" /> : null}
				</button>
			))}
			<label
				className={cn(
					"relative size-5 cursor-pointer overflow-hidden rounded-full ring-offset-2 ring-offset-[var(--app-settings-surface)]",
					!isPreset && "ring-2 ring-[color:var(--color-border-heavy)]",
				)}
				style={{
					background: isPreset
						? "conic-gradient(#e5484d, #ffb224, #30a46c, #12a594, #339cff, #6e56cf, #d6409f, #e5484d)"
						: value,
				}}
				title={t("settings.accentColorCustom")}
			>
				<input
					aria-label={t("settings.accentColorCustom")}
					className="absolute inset-0 cursor-pointer opacity-0"
					onChange={(event) => onChange(event.currentTarget.value)}
					type="color"
					value={value}
				/>
			</label>
		</div>
	);
}

/** A swatch that opens the system color picker, with the hex value beside it. */
function ColorPicker({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
	return (
		<label className="flex cursor-pointer items-center gap-2">
			<span className="font-mono text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{value}</span>
			<span
				className="relative size-5 overflow-hidden rounded-full border border-[color:var(--color-border-heavy)]"
				style={{ backgroundColor: value }}
			>
				<input
					aria-label={label}
					className="absolute inset-0 cursor-pointer opacity-0"
					onChange={(event) => onChange(event.currentTarget.value)}
					type="color"
					value={value}
				/>
			</span>
		</label>
	);
}

/** Reads a pasted share string, or says it is not one. */
function readThemeShare(value: string): ThemeSharePayload | null {
	if (!value.trim()) return null;
	try {
		return parseThemeShareString(value);
	} catch {
		return null;
	}
}

/** A `.codex-theme` package, or why it is not one. */
function readThemePackage(source: string): { theme: CommunityTheme } | { error: string } {
	try {
		return { theme: parseThemePackage(source).theme };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function ColorDots({ colors }: { colors: readonly string[] }) {
	return (
		<span className="flex shrink-0 gap-1">
			{colors.map((color, index) => (
				<span
					key={index}
					className="size-3.5 rounded-full border border-[color:var(--color-border-heavy)]"
					style={{ backgroundColor: color }}
				/>
			))}
		</span>
	);
}

/**
 * Bring a theme in: a share string pasted from this app or Codex, or a
 * `.codex-theme` package downloaded from codexthemes.ai — of which only the
 * palette and the artwork are used.
 */
function ThemeImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (value: string, variant: ThemeVariant) => void }) {
	const { t } = useTranslation();
	const [value, setValue] = useState("");
	const [file, setFile] = useState<{ name: string; source: string } | null>(null);
	const [folder, setFolder] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const trimmed = value.trim();
	const share = !file && !folder && trimmed ? readThemeShare(trimmed) : null;
	const packageSource = file?.source ?? (trimmed.startsWith("{") ? trimmed : null);
	const pack = useMemo(() => (packageSource ? readThemePackage(packageSource) : null), [packageSource]);
	const packTheme = pack && "theme" in pack ? pack.theme : null;
	const invalid =
		pack && "error" in pack ? pack.error : trimmed && !share && !packageSource ? t("settings.themeImportInvalid") : null;
	const variantName = (variant: ThemeVariant) => t(variant === "dark" ? "theme.dark" : "theme.light");

	const chooseFolder = async () => {
		setError(null);
		const chosen = await api.themesChooseDirectory();
		if (chosen) {
			setFile(null);
			setValue("");
			setFolder(chosen);
		}
	};

	const chooseFile = async (chosen: File | undefined) => {
		if (!chosen) return;
		setError(null);
		if (chosen.size > MAX_THEME_PACKAGE_BYTES) {
			setError(t("settings.themePackageTooLarge"));
			return;
		}
		const source = await chosen.text();
		if (source.trim().startsWith("codex-theme-v1:")) {
			setFile(null);
			setFolder(null);
			setValue(source.trim());
		} else {
			setValue("");
			setFolder(null);
			setFile({ name: chosen.name, source });
		}
	};

	const apply = async () => {
		setError(null);
		if (share) {
			onImport(trimmed, share.variant);
			onClose();
			return;
		}
		if (folder) {
			setBusy(true);
			try {
				await api.themesInstallDirectory(folder);
				onClose();
			} catch (cause) {
				setError(errorMessage(cause));
			} finally {
				setBusy(false);
			}
			return;
		}
		if (!packageSource || !packTheme) return;
		setBusy(true);
		try {
			await installThemePackage(packageSource);
			onClose();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<SettingsDialog
			title={t("settings.themeImport")}
			description={t("settings.themeImportHint")}
			onClose={onClose}
			footer={
				<>
					<input
						accept={`${THEME_PACKAGE_EXTENSION},.json,application/json`}
						className="hidden"
						onChange={(event) => {
							void chooseFile(event.currentTarget.files?.[0]);
							event.currentTarget.value = "";
						}}
						ref={fileInput}
						type="file"
					/>
					<Button className="mr-auto" onClick={() => fileInput.current?.click()} size="sm" variant="subtle">
						{t("settings.themeImportFile")}
					</Button>
					{api.runtime === "electron" ? (
						<Button onClick={() => void chooseFolder()} size="sm" variant="subtle">
							{t("settings.themeImportFolder")}
						</Button>
					) : null}
					<Button onClick={onClose} size="sm" variant="subtle">
						{t("common.cancel")}
					</Button>
					<Button disabled={busy || !(share || packTheme || folder)} onClick={() => void apply()} size="sm">
						{t("settings.themeImportApply")}
					</Button>
				</>
			}
		>
			{file || folder ? (
				<div className="flex items-center gap-2 rounded-lg border border-[color:var(--color-border)] px-2 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)]">
					<span className="min-w-0 flex-1 truncate font-mono">{file?.name ?? folder}</span>
					<Button aria-label={t("common.clear")} onClick={() => { setFile(null); setFolder(null); }} size="icon-chip" variant="ghost">
						<XIcon />
					</Button>
				</div>
			) : (
				<textarea
					aria-label={t("settings.themeImport")}
					autoFocus
					className={cn(SETTINGS_TEXTAREA_CLASS_NAME, "h-32")}
					onChange={(event) => setValue(event.currentTarget.value)}
					placeholder="codex-theme-v1:{…}"
					spellCheck={false}
					value={value}
				/>
			)}
			{error || invalid ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error ?? invalid}</p>
			) : share ? (
				<p className="flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					<ColorDots colors={[share.theme.surface, share.theme.ink, share.theme.accent]} />
					{t("settings.themeImportTarget", { variant: variantName(share.variant) })}
					{share.unknownCodeThemeId ? ` ${t("settings.themeImportUnknownCode", { id: share.unknownCodeThemeId })}` : null}
				</p>
			) : folder ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("settings.themeImportFolderReady")}</p>
			) : packTheme ? (
				<p className="flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					<ColorDots colors={[packTheme.colors.surface, packTheme.colors.ink, packTheme.colors.accent]} />
					<span>
						{t("settings.themePackagePreview", { name: packTheme.name, variant: variantName(packTheme.variant) })}
						{packTheme.art ? ` ${t("settings.themePackageHasArt")}` : null} {t("settings.themePackageCssNote")}
					</span>
				</p>
			) : null}
		</SettingsDialog>
	);
}

/** The installed community themes: apply one, remove one, or open their folder. */
function CommunityThemesDialog({ onClose, onImport }: { onClose: () => void; onImport: () => void }) {
	const { t } = useTranslation();
	const library = useThemeLibrary();
	const { themeState } = useTheme();
	const [error, setError] = useState<string | null>(null);
	const themes = library?.themes ?? [];
	return (
		<SettingsDialog
			title={t("settings.communityThemes")}
			description={library?.dir}
			onClose={onClose}
			footer={
				<>
					{api.runtime === "electron" ? (
						<Button
							className="mr-auto"
							onClick={() => void api.themesOpenDir().catch((cause) => setError(errorMessage(cause)))}
							size="sm"
							variant="subtle"
						>
							{t("settings.communityThemesOpenDir")}
						</Button>
					) : null}
					<Button onClick={onImport} size="sm" variant="subtle">
						{t("settings.themeImport")}
					</Button>
					<Button onClick={onClose} size="sm">
						{t("common.close")}
					</Button>
				</>
			}
		>
			{themes.length === 0 ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("settings.communityThemesEmpty")}</p>
			) : (
				<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
					{themes.map((theme) => {
						const active = themeState.communityThemeIds[theme.variant] === theme.id;
						return (
							<div key={theme.id} className="flex items-center gap-3 py-2">
								<ColorDots colors={[theme.colors.surface, theme.colors.ink, theme.colors.accent]} />
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-[length:var(--app-font-size-ui,12px)]">{theme.name}</span>
									<span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
										{[
											theme.id,
											t(theme.variant === "dark" ? "theme.dark" : "theme.light"),
											theme.art ? t("settings.communityThemeArt") : null,
											theme.author,
										]
											.filter(Boolean)
											.join(" · ")}
									</span>
								</div>
								<Button disabled={active} onClick={() => applyCommunityThemeNow(theme)} size="sm" variant="subtle">
									{active ? t("settings.communityThemeInUse") : t("settings.communityThemeApply")}
								</Button>
								<Button
									aria-label={t("common.delete")}
									onClick={() => void removeCommunityTheme(theme.id).catch((cause) => setError(errorMessage(cause)))}
									size="icon-chip"
									title={t("common.delete")}
									variant="ghost"
								>
									<XIcon />
								</Button>
							</div>
						);
					})}
				</div>
			)}
			{error ? <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p> : null}
		</SettingsDialog>
	);
}

export function AppearanceSettings() {
	const { t } = useTranslation();
	const {
		theme,
		activeTheme,
		resolvedTheme,
		setTheme,
		themeState,
		setCodeThemeId,
		systemUiFont,
		setSystemUiFont,
		windowMaterial,
		setWindowMaterial,
		supportedWindowMaterials,
		updateThemePack,
		resetAllThemes,
		exportThemeString,
		importThemeString,
		communityThemeId,
		artStrength,
		setArtStrength,
	} = useTheme();
	const library = useThemeLibrary();
	const communityThemes = library?.themes ?? [];
	const activeCommunity = communityThemeId ? communityThemes.find((entry) => entry.id === communityThemeId) : undefined;
	const [managing, setManaging] = useState(false);
	const { preferences, updatePreferences, resetPreferences } = useAppearancePreferences();
	const codeThemes = useMemo(() => getAvailableCodeThemes(resolvedTheme), [resolvedTheme]);
	const activeCodeThemeId = themeState.codeThemeIds[resolvedTheme as ThemeVariant];
	const [menuOpen, setMenuOpen] = useState(false);
	const [materialMenuOpen, setMaterialMenuOpen] = useState(false);
	const [importing, setImporting] = useState(false);
	const [copied, setCopied] = useState(false);
	const copyTheme = async () => {
		await copyText(exportThemeString(resolvedTheme as ThemeVariant));
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1500);
	};
	// Windows before 11 22H2 (and every other platform) can only paint the opaque
	// shell; the rest stay listed but unpickable, so the setting explains itself
	// instead of silently vanishing.
	const hasBackdrops = supportedWindowMaterials.length > 1;
	const variantLabel = t(resolvedTheme === "dark" ? "theme.dark" : "theme.light");
	const scaledCodePx = getAppTypographyScale(preferences.fontSizePx).chatCodePx;
	const defaults = DEFAULT_APPEARANCE_PREFERENCES;

	return (
		<div className="flex flex-col gap-6">
			<SettingsGroup title={t("settings.appearance.group.theme")}>
				<SettingsRow hint={t("settings.themeModeHint")} label={t("settings.themeMode")}>
					<SegmentedControl
						onChange={setTheme}
						options={MODES.map((entry) => ({ id: entry.id, label: t(entry.labelKey) }))}
						value={theme}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.codeThemeHint", { variant: variantLabel })} label={t("settings.codeTheme")}>
					<Menu open={menuOpen} onOpenChange={setMenuOpen}>
						<MenuTrigger
							render={
								<Button
									className={cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "border-transparent")}
									size="chip"
									variant="ghost"
								>
									<span className="truncate">
										{activeCommunity?.name ??
											codeThemes.find((option) => option.id === activeCodeThemeId)?.label ??
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
								value={activeCommunity ? `community:${activeCommunity.id}` : activeCodeThemeId}
								onValueChange={(value) => {
									const community = value.startsWith("community:")
										? communityThemes.find((entry) => `community:${entry.id}` === value)
										: undefined;
									if (community) applyCommunityThemeNow(community);
									else setCodeThemeId(resolvedTheme as ThemeVariant, value);
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
								{communityThemes.length > 0 ? (
									<MenuGroupLabel>{t("settings.communityThemes")}</MenuGroupLabel>
								) : null}
								{/* A community theme is made for one variant; picking one from the
								    other switches the mode so it can be seen. */}
								{communityThemes.map((entry) => (
									<MenuRadioItem
										key={entry.id}
										className={COMPOSER_PICKER_MENU_OPTION_CLASS_NAME}
										value={`community:${entry.id}`}
									>
										{entry.name}
										{entry.variant !== resolvedTheme
											? ` · ${t(entry.variant === "dark" ? "theme.dark" : "theme.light")}`
											: null}
									</MenuRadioItem>
								))}
							</MenuRadioGroup>
						</ComposerPickerMenuPopup>
					</Menu>
				</SettingsRow>

				<SettingsRow
					hint={t("settings.communityThemesHint", { count: communityThemes.length })}
					label={t("settings.communityThemes")}
				>
					<Button onClick={() => setManaging(true)} size="sm" variant="subtle">
						{t("settings.communityThemesManage")}
					</Button>
				</SettingsRow>

				{activeCommunity?.art ? (
					<SettingsRow hint={t("settings.artStrengthHint")} label={t("settings.artStrength")}>
						<div className="flex items-center gap-2">
							<input
								aria-label={t("settings.artStrength")}
								className="theme-slider h-1 w-36 cursor-pointer appearance-none rounded-full bg-[color-mix(in_srgb,var(--color-text-foreground)_14%,transparent)]"
								max={100}
								min={0}
								onChange={(event) => setArtStrength(Number(event.currentTarget.value))}
								step={1}
								type="range"
								value={artStrength}
							/>
							<span className="w-7 text-right text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground">
								{artStrength}
							</span>
						</div>
					</SettingsRow>
				) : null}

				<SettingsRow hint={t("settings.accentColorHint", { variant: variantLabel })} label={t("settings.accentColor")}>
					<AccentPicker
						onChange={(accent) => updateThemePack(resolvedTheme, { accent })}
						value={activeTheme.theme.accent}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.surfaceColorHint", { variant: variantLabel })} label={t("settings.surfaceColor")}>
					<ColorPicker
						label={t("settings.surfaceColor")}
						onChange={(surface) => updateThemePack(resolvedTheme, { surface })}
						value={activeTheme.theme.surface}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.inkColorHint", { variant: variantLabel })} label={t("settings.inkColor")}>
					<ColorPicker
						label={t("settings.inkColor")}
						onChange={(ink) => updateThemePack(resolvedTheme, { ink })}
						value={activeTheme.theme.ink}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.contrastHint", { variant: variantLabel })} label={t("settings.contrast")}>
					<div className="flex items-center gap-2">
						<input
							aria-label={t("settings.contrast")}
							className="theme-slider h-1 w-36 cursor-pointer appearance-none rounded-full bg-[color-mix(in_srgb,var(--color-text-foreground)_14%,transparent)]"
							max={100}
							min={0}
							onChange={(event) => updateThemePack(resolvedTheme, { contrast: Number(event.currentTarget.value) })}
							step={1}
							type="range"
							value={activeTheme.theme.contrast}
						/>
						<span className="w-7 text-right text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground">
							{activeTheme.theme.contrast}
						</span>
					</div>
				</SettingsRow>

				<SettingsRow hint={t("settings.themeShareHint", { variant: variantLabel })} label={t("settings.themeShare")}>
					<div className="flex items-center gap-1.5">
						<Button onClick={() => void copyTheme()} size="sm" variant="subtle">
							{copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
							{copied ? t("settings.themeCopied") : t("settings.themeCopy")}
						</Button>
						<Button onClick={() => setImporting(true)} size="sm" variant="subtle">
							{t("settings.themeImport")}
						</Button>
					</div>
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
			</SettingsGroup>

			<SettingsGroup title={t("settings.appearance.group.fonts")}>
				<SettingsRow hint={t("settings.uiFontHint")} label={t("settings.uiFont")}>
					<div className="flex items-center gap-1">
						<FontFamilyPicker
							onChange={(uiFontFamily) => updatePreferences({ uiFontFamily })}
							placeholder={t("settings.fontDefault")}
							value={preferences.uiFontFamily}
						/>
						<ClearFontButton onClear={() => updatePreferences({ uiFontFamily: null })} visible={preferences.uiFontFamily !== null} />
					</div>
				</SettingsRow>

				<SettingsRow hint={t("settings.systemUiFontHint")} label={t("settings.systemUiFont")}>
					<Switch
						checked={systemUiFont}
						disabled={preferences.uiFontFamily !== null}
						onCheckedChange={(checked) => setSystemUiFont(checked)}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.codeFontHint")} label={t("settings.codeFont")}>
					<div className="flex items-center gap-1">
						<FontFamilyPicker
							monospace
							onChange={(codeFontFamily) => updatePreferences({ codeFontFamily })}
							placeholder={t("settings.fontDefault")}
							value={preferences.codeFontFamily}
						/>
						<ClearFontButton
							onClear={() => updatePreferences({ codeFontFamily: null })}
							visible={preferences.codeFontFamily !== null}
						/>
					</div>
				</SettingsRow>

				<SettingsRow hint={t("settings.fontSizeHint")} label={t("settings.fontSize")}>
					<SizeStepper
						max={FONT_SIZE_RANGE.max}
						min={FONT_SIZE_RANGE.min}
						onChange={(fontSizePx) => updatePreferences({ fontSizePx })}
						onReset={
							preferences.fontSizePx !== defaults.fontSizePx
								? () => updatePreferences({ fontSizePx: defaults.fontSizePx })
								: undefined
						}
						value={preferences.fontSizePx}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.codeFontSizeHint")} label={t("settings.codeFontSize")}>
					<SizeStepper
						label={
							preferences.codeFontSizePx === null
								? `${t("settings.fontSizeAuto")} · ${scaledCodePx}px`
								: undefined
						}
						max={MONO_FONT_SIZE_RANGE.max}
						min={MONO_FONT_SIZE_RANGE.min}
						onChange={(codeFontSizePx) => updatePreferences({ codeFontSizePx })}
						onReset={
							preferences.codeFontSizePx !== null
								? () => updatePreferences({ codeFontSizePx: null })
								: undefined
						}
						value={preferences.codeFontSizePx ?? scaledCodePx}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.terminalFontSizeHint")} label={t("settings.terminalFontSize")}>
					<SizeStepper
						max={MONO_FONT_SIZE_RANGE.max}
						min={MONO_FONT_SIZE_RANGE.min}
						onChange={(terminalFontSizePx) => updatePreferences({ terminalFontSizePx })}
						onReset={
							preferences.terminalFontSizePx !== defaults.terminalFontSizePx
								? () => updatePreferences({ terminalFontSizePx: defaults.terminalFontSizePx })
								: undefined
						}
						value={preferences.terminalFontSizePx}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.editorFontSizeHint")} label={t("settings.editorFontSize")}>
					<SizeStepper
						max={MONO_FONT_SIZE_RANGE.max}
						min={MONO_FONT_SIZE_RANGE.min}
						onChange={(editorFontSizePx) => updatePreferences({ editorFontSizePx })}
						onReset={
							preferences.editorFontSizePx !== defaults.editorFontSizePx
								? () => updatePreferences({ editorFontSizePx: defaults.editorFontSizePx })
								: undefined
						}
						value={preferences.editorFontSizePx}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.codeLigaturesHint")} label={t("settings.codeLigatures")}>
					<Switch
						checked={preferences.codeLigatures}
						onCheckedChange={(codeLigatures) => updatePreferences({ codeLigatures })}
					/>
				</SettingsRow>

				<div className="flex flex-col gap-1.5 py-2.5">
					<span className="text-[length:var(--app-font-size-ui,12px)]">{t("settings.fontPreview")}</span>
					<div className="flex flex-col gap-1 rounded-lg border border-[color:var(--color-border)] px-3 py-2">
						<span className="font-sans text-[length:var(--app-font-size-chat-body,13px)]">{PREVIEW_TEXT}</span>
						<code className="font-chat-code text-[length:var(--app-font-size-chat-code,11px)] text-muted-foreground">
							{"const neko = (paws) => paws !== 0 && paws <= 4; // 喵"}
						</code>
					</div>
				</div>
			</SettingsGroup>

			<SettingsGroup title={t("settings.appearance.group.layout")}>
				<SettingsRow hint={t("settings.densityHint")} label={t("settings.density")}>
					<SegmentedControl
						onChange={(density) => updatePreferences({ density })}
						options={UI_DENSITY_MODES.map((id) => ({ id, label: t(DENSITY_LABEL_KEYS[id]) }))}
						value={preferences.density}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.chatWidthHint")} label={t("settings.chatWidth")}>
					<SegmentedControl
						onChange={(chatWidth) => updatePreferences({ chatWidth })}
						options={CHAT_WIDTH_MODES.map((id) => ({ id, label: t(CHAT_WIDTH_LABEL_KEYS[id]) }))}
						value={preferences.chatWidth}
					/>
				</SettingsRow>

				<SettingsRow hint={t("settings.resetAppearanceHint")} label={t("settings.resetAppearance")}>
					<Button
						onClick={() => {
							resetAllThemes();
							resetPreferences();
						}}
						size="sm"
						variant="chrome-outline"
					>
						{t("common.reset")}
					</Button>
				</SettingsRow>
			</SettingsGroup>

			{importing ? <ThemeImportDialog onClose={() => setImporting(false)} onImport={importThemeString} /> : null}
			{managing ? (
				<CommunityThemesDialog
					onClose={() => setManaging(false)}
					onImport={() => {
						setManaging(false);
						setImporting(true);
					}}
				/>
			) : null}
		</div>
	);
}
