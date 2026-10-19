// FILE: FontFamilyPicker.tsx
// Purpose: The searchable font dropdown behind Settings → Appearance's UI and code
// font rows. Lists installed fonts under their Chinese names, each drawn in its
// own face, plus fonts the user imported — and imports more.

import { Popover } from "@base-ui/react/popover";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fontDisplayName, type FontInfo } from "../../../../shared/font-names";
import { useFontLibrary } from "../../hooks/useFontLibrary";
import { useTranslation, type TranslationKey } from "../../i18n";
import { DEFAULT_MONOSPACE_FONT_FAMILY_STACK, DEFAULT_UI_FONT_FAMILY_STACK } from "../../lib/fontFamily";
import {
	FontImportError,
	IMPORTABLE_FONT_EXTENSIONS,
	importFontFile,
	removeImportedFont,
	type ImportedFont,
} from "../../lib/importedFonts";
import { CheckIcon, ChevronsUpDownIcon, PlusIcon, XIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME, COMPOSER_SURFACE_SHADOW_CLASS_NAME } from "../chat/composerPickerStyles";
import { Spinner } from "../ui/spinner";

type Row =
	| { kind: "default" }
	| { kind: "custom"; value: string }
	| { kind: "font"; font: FontInfo; imported?: ImportedFont };

interface Section {
	titleKey?: TranslationKey;
	rows: Row[];
}

const IMPORT_ERROR_KEYS: Record<FontImportError["code"], TranslationKey> = {
	unsupported: "settings.fontPicker.error.unsupported",
	tooLarge: "settings.fontPicker.error.tooLarge",
	invalid: "settings.fontPicker.error.invalid",
};

function quoteFamily(family: string): string {
	return `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The first family of a CSS-style list, unquoted — what the value is "named". */
function primaryFamily(value: string): string {
	return value.split(",")[0].trim().replace(/^(["'])(.*)\1$/, "$2");
}

function rowKey(row: Row): string {
	if (row.kind === "font") return `font:${row.imported?.id ?? row.font.family}`;
	return row.kind;
}

export function FontFamilyPicker({
	value,
	onChange,
	monospace = false,
	placeholder,
}: {
	value: string | null;
	onChange: (value: string | null) => void;
	/** Code font: puts monospaced fonts first and previews in a mono fallback. */
	monospace?: boolean;
	placeholder: string;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState(0);
	const [importing, setImporting] = useState(false);
	const [messages, setMessages] = useState<{ tone: "error" | "info"; text: string }[]>([]);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const { system, imported } = useFontLibrary(open);
	const fallbackStack = monospace ? DEFAULT_MONOSPACE_FONT_FAMILY_STACK : DEFAULT_UI_FONT_FAMILY_STACK;

	const selectedFamily = value ? primaryFamily(value).toLowerCase() : null;
	const knownFont = useMemo(() => {
		if (!selectedFamily) return null;
		return (
			imported.find((font) => font.family.toLowerCase() === selectedFamily) ??
			system?.find((font) => font.family.toLowerCase() === selectedFamily) ??
			null
		);
	}, [imported, system, selectedFamily]);

	const sections = useMemo<Section[]>(() => {
		const needle = query.trim().toLowerCase();
		const matches = (font: FontInfo) =>
			!needle ||
			font.family.toLowerCase().includes(needle) ||
			(font.localizedFamily?.toLowerCase().includes(needle) ?? false);

		const importedFamilies = new Set(imported.map((font) => font.family.toLowerCase()));
		const importedRows: Row[] = imported.filter(matches).map((font) => ({ kind: "font", font, imported: font }));
		const groups: Record<"monospace" | "chinese" | "other", Row[]> = { monospace: [], chinese: [], other: [] };
		for (const font of system ?? []) {
			if (importedFamilies.has(font.family.toLowerCase()) || !matches(font)) continue;
			// Classic CJK faces (黑体, 楷体, 仿宋) flag themselves fixed-pitch for their
			// half-width Latin, but aren't code fonts; Chinese mono fonts say so by name.
			const codeFont = font.monospace && (!font.chinese || /mono/i.test(font.family));
			const group = monospace && codeFont ? "monospace" : font.chinese ? "chinese" : "other";
			groups[group].push({ kind: "font", font });
		}

		const lead: Row[] = [];
		if (!needle) lead.push({ kind: "default" });
		const exact = [...imported, ...(system ?? [])].some(
			(font) => font.family.toLowerCase() === needle || font.localizedFamily?.toLowerCase() === needle,
		);
		if (needle && !exact) lead.push({ kind: "custom", value: query.trim() });

		const ordered: Section[] = [
			{ rows: lead },
			{ titleKey: "settings.fontPicker.group.imported", rows: importedRows },
			...(monospace
				? [
						{ titleKey: "settings.fontPicker.group.monospace" as const, rows: groups.monospace },
						{ titleKey: "settings.fontPicker.group.chinese" as const, rows: groups.chinese },
					]
				: [{ titleKey: "settings.fontPicker.group.chinese" as const, rows: groups.chinese }]),
			{ titleKey: "settings.fontPicker.group.other", rows: groups.other },
		];
		return ordered.filter((section) => section.rows.length > 0);
	}, [imported, system, query, monospace]);

	const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

	useEffect(() => {
		setHighlight(0);
	}, [query, open]);

	useEffect(() => {
		if (!open) {
			setQuery("");
			setMessages([]);
		}
	}, [open]);

	useEffect(() => {
		listRef.current
			?.querySelector<HTMLElement>(`[data-row-index="${highlight}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	const choose = (row: Row) => {
		if (row.kind === "default") onChange(null);
		else if (row.kind === "custom") onChange(row.value);
		else onChange(row.font.family);
		setOpen(false);
	};

	const importFiles = async (files: FileList | null) => {
		if (!files?.length) return;
		setImporting(true);
		const next: { tone: "error" | "info"; text: string }[] = [];
		let last: ImportedFont | null = null;
		for (const file of Array.from(files)) {
			try {
				last = await importFontFile(file);
				next.push({ tone: "info", text: t("settings.fontPicker.imported", { name: fontDisplayName(last) }) });
			} catch (error) {
				const code = error instanceof FontImportError ? error.code : "invalid";
				next.push({ tone: "error", text: t(IMPORT_ERROR_KEYS[code], { name: file.name }) });
			}
		}
		setImporting(false);
		setMessages(next);
		if (fileRef.current) fileRef.current.value = "";
		if (last) onChange(last.family);
		// Close only on a clean import; otherwise leave the errors on screen.
		if (last && next.every((message) => message.tone === "info")) setOpen(false);
	};

	const triggerLabel = value ? (knownFont ? fontDisplayName(knownFont) : value) : placeholder;
	let rowIndex = -1;

	return (
		<Popover.Root onOpenChange={setOpen} open={open}>
			<Popover.Trigger
				className={cn(
					"inline-flex h-7 w-56 min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-2.5 text-left text-[length:var(--app-font-size-ui-sm,11px)] outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:border-foreground/30 data-[popup-open]:border-foreground/30 dark:bg-input/32",
				)}
			>
				<span
					className={cn("min-w-0 flex-1 truncate", !value && "text-muted-foreground")}
					style={value ? { fontFamily: `${quoteFamily(primaryFamily(value))}, ${fallbackStack}` } : undefined}
				>
					{triggerLabel}
				</span>
				<ChevronsUpDownIcon className="size-3 shrink-0 opacity-50" />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={4}>
					<Popover.Popup
						data-settings-surface="popup"
						className={cn(
							APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME,
							COMPOSER_SURFACE_SHADOW_CLASS_NAME,
							"flex w-80 origin-(--transform-origin) flex-col rounded-lg outline-none",
						)}
						initialFocus={searchRef}
					>
						<div className="border-b border-[color:var(--color-border)] p-1.5">
							<input
								ref={searchRef}
								className="font-system-ui h-7 w-full rounded-md bg-transparent px-2 text-[length:var(--app-font-size-ui-sm,11px)] outline-none placeholder:text-muted-foreground/72"
								onChange={(event) => setQuery(event.currentTarget.value)}
								onKeyDown={(event) => {
									if (event.key === "ArrowDown") {
										event.preventDefault();
										setHighlight((index) => Math.min(rows.length - 1, index + 1));
									} else if (event.key === "ArrowUp") {
										event.preventDefault();
										setHighlight((index) => Math.max(0, index - 1));
									} else if (event.key === "Enter") {
										event.preventDefault();
										const row = rows[highlight];
										if (row) choose(row);
									}
								}}
								placeholder={t("settings.fontPicker.search")}
								spellCheck={false}
								value={query}
							/>
						</div>

						<div ref={listRef} className="max-h-72 overflow-y-auto overscroll-contain p-1" role="listbox">
							{system === null ? (
								<div className="flex items-center gap-2 px-2 py-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
									<Spinner className="size-3" />
									{t("settings.fontPicker.loading")}
								</div>
							) : null}
							{sections.map((section, sectionIndex) => (
								<div key={section.titleKey ?? `lead-${sectionIndex}`} role="group">
									{section.titleKey ? (
										<div className="px-2 pb-0.5 pt-2 text-[length:var(--app-font-size-ui-2xs,9px)] font-medium text-muted-foreground">
											{t(section.titleKey)}
										</div>
									) : null}
									{section.rows.map((row) => {
										rowIndex += 1;
										const index = rowIndex;
										return (
											<PickerRow
												key={rowKey(row)}
												active={index === highlight}
												fallbackStack={fallbackStack}
												index={index}
												onHover={() => setHighlight(index)}
												onSelect={() => choose(row)}
												row={row}
												selected={
													row.kind === "default"
														? value === null
														: row.kind === "font" && row.font.family.toLowerCase() === selectedFamily
												}
											>
												{row.kind === "default"
													? t("settings.fontPicker.default")
													: row.kind === "custom"
														? t("settings.fontPicker.useCustom", { name: row.value })
														: null}
											</PickerRow>
										);
									})}
								</div>
							))}
							{system !== null && rows.length === 0 ? (
								<div className="px-2 py-3 text-center text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
									{t("settings.fontPicker.empty")}
								</div>
							) : null}
						</div>

						<div className="flex flex-col gap-1 border-t border-[color:var(--color-border)] p-1.5">
							{messages.map((message, index) => (
								<p
									key={index}
									className={cn(
										"px-1 text-[length:var(--app-font-size-ui-xs,10px)]",
										message.tone === "error" ? "text-destructive" : "text-muted-foreground",
									)}
								>
									{message.text}
								</p>
							))}
							<button
								className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-button-secondary-hover)] disabled:opacity-64"
								disabled={importing}
								onClick={() => fileRef.current?.click()}
								type="button"
							>
								{importing ? <Spinner className="size-3" /> : <PlusIcon className="size-3" />}
								<span className="flex-1">
									{importing ? t("settings.fontPicker.importing") : t("settings.fontPicker.import")}
								</span>
								<span className="text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
									{t("settings.fontPicker.importHint")}
								</span>
							</button>
							<input
								ref={fileRef}
								accept={IMPORTABLE_FONT_EXTENSIONS.join(",")}
								className="hidden"
								multiple
								onChange={(event) => void importFiles(event.currentTarget.files)}
								type="file"
							/>
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

function PickerRow({
	row,
	index,
	active,
	selected,
	fallbackStack,
	onHover,
	onSelect,
	children,
}: {
	row: Row;
	index: number;
	active: boolean;
	selected: boolean;
	fallbackStack: string;
	onHover: () => void;
	onSelect: () => void;
	children: ReactNode;
}) {
	const { t } = useTranslation();
	const font = row.kind === "font" ? row.font : null;
	return (
		<div
			aria-selected={selected}
			className="group flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[length:var(--app-font-size-ui,12px)] data-[active=true]:bg-[var(--color-background-button-secondary-hover)]"
			data-active={active}
			data-row-index={index}
			onClick={onSelect}
			onMouseMove={active ? undefined : onHover}
			role="option"
			// Off-screen rows skip layout and paint, so a long list doesn't load
			// every font face just to open.
			style={{ contentVisibility: "auto", containIntrinsicSize: "auto 2rem" }}
		>
			{font ? (
				<>
					<span
						className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-chat-body,13px)]"
						style={{ fontFamily: `${quoteFamily(font.family)}, ${fallbackStack}` }}
					>
						{fontDisplayName(font)}
					</span>
					{font.localizedFamily ? (
						<span className="max-w-28 shrink-0 truncate text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
							{font.family}
						</span>
					) : null}
				</>
			) : (
				<span className="min-w-0 flex-1 truncate">{children}</span>
			)}
			{row.kind === "font" && row.imported ? (
				<button
					aria-label={t("settings.fontPicker.remove")}
					className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-data-[active=true]:opacity-100"
					onClick={(event) => {
						event.stopPropagation();
						void removeImportedFont(row.imported!.id);
					}}
					title={t("settings.fontPicker.remove")}
					type="button"
				>
					<XIcon className="size-3" />
				</button>
			) : null}
			<CheckIcon className={cn("size-3 shrink-0", !selected && "invisible")} />
		</div>
	);
}
