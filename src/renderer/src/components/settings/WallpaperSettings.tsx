import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../../api";
import { useWallpaperPreferences } from "../../hooks/useWallpaperPreferences";
import { useTranslation, type TranslationKey } from "../../i18n";
import { wallpaperPreviewUrl, wallpaperUploadUrl, type WallpaperEntry, type WallpaperFit, type WallpaperLibrary, type WallpaperOrigin, type WallpaperUpload, type WeWallpaperType } from "../../../../shared/wallpaper";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { CheckIcon, XIcon } from "../../lib/icons";
import { SettingsDialog } from "./SettingsDialog";
import { SettingsRow } from "./SettingsRow";

const SOURCES = ["none", "image", "engine"] as const;
const FITS: readonly WallpaperFit[] = ["cover", "contain", "stretch"];
const TYPES = ["all", "scene", "video", "web"] as const;
const SOURCE_KEYS: Record<(typeof SOURCES)[number], TranslationKey> = {
	none: "settings.wallpaper.off",
	image: "settings.wallpaper.image",
	engine: "settings.wallpaper.engine",
};
const FIT_KEYS: Record<WallpaperFit, TranslationKey> = {
	cover: "settings.wallpaper.fit.cover",
	contain: "settings.wallpaper.fit.contain",
	stretch: "settings.wallpaper.fit.stretch",
};
const TYPE_KEYS: Record<(typeof TYPES)[number], TranslationKey> = {
	all: "settings.wallpaper.type.all",
	scene: "settings.wallpaper.type.scene",
	video: "settings.wallpaper.type.video",
	web: "settings.wallpaper.type.web",
};
const CHOOSE_ERRORS: Record<string, TranslationKey> = {
	"too-large": "settings.wallpaper.tooLarge",
	unsupported: "settings.wallpaper.unsupported",
	limit: "settings.wallpaper.limit",
	failed: "settings.wallpaper.failed",
};

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col">
			<h3 className="pb-1 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground">{title}</h3>
			<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">{children}</div>
		</section>
	);
}

function Segmented<T extends string>({
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

function Slider({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (value: number) => void }) {
	return (
		<div className="flex items-center gap-2">
			<input
				aria-label={label}
				className="theme-slider h-1 w-36 cursor-pointer appearance-none rounded-full bg-[color-mix(in_srgb,var(--color-text-foreground)_14%,transparent)]"
				max={max}
				min={0}
				onChange={(event) => onChange(Number(event.currentTarget.value))}
				step={1}
				type="range"
				value={value}
			/>
			<span className="w-7 text-right text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground">{value}</span>
		</div>
	);
}

function typeLabel(type: WeWallpaperType, t: (key: TranslationKey) => string): string {
	if (type === "scene" || type === "video" || type === "web") return t(TYPE_KEYS[type]);
	return t("settings.wallpaper.type.application");
}

export function WallpaperSettings() {
	const { t } = useTranslation();
	const { preferences, updatePreferences } = useWallpaperPreferences();
	const desktop = api.runtime === "electron";
	const [origin, setOrigin] = useState<WallpaperOrigin | null>(null);
	const [uploads, setUploads] = useState<WallpaperUpload[]>([]);
	const [library, setLibrary] = useState<WallpaperLibrary | null>(null);
	const [libraryError, setLibraryError] = useState<string | null>(null);
	const [loadingLibrary, setLoadingLibrary] = useState(false);
	const [picking, setPicking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [type, setType] = useState<(typeof TYPES)[number]>("all");

	const reloadUploads = async () => {
		setUploads(await api.wallpaperUploads());
	};

	useEffect(() => {
		if (!desktop) return;
		let cancel = false;
		void api.wallpaperOrigin().then((next) => {
			if (!cancel) setOrigin(next);
		}).catch((cause) => {
			if (!cancel) setError(errorMessage(cause));
		});
		void reloadUploads().catch((cause) => {
			if (!cancel) setError(errorMessage(cause));
		});
		return () => {
			cancel = true;
		};
	}, [desktop]);

	const openLibrary = async (refresh = false) => {
		setPicking(true);
		setLoadingLibrary(true);
		setLibraryError(null);
		try {
			setLibrary(await api.wallpaperLibrary(refresh));
		} catch (cause) {
			setLibraryError(errorMessage(cause));
		} finally {
			setLoadingLibrary(false);
		}
	};

	const upload = async () => {
		setError(null);
		const result = await api.wallpaperChooseImage();
		if (!result.ok) {
			if (result.error !== "canceled") setError(t(CHOOSE_ERRORS[result.error] ?? "settings.wallpaper.failed"));
			return;
		}
		updatePreferences({ source: "image", imageId: result.upload.id });
		await reloadUploads();
	};

	const removeUpload = async (id: string) => {
		setError(null);
		await api.wallpaperRemoveUpload(id);
		if (preferences.imageId === id) updatePreferences({ imageId: null });
		await reloadUploads();
	};

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return (library?.wallpapers ?? []).filter((entry) => {
			if (type !== "all" && entry.type !== type) return false;
			if (!needle) return true;
			return entry.title.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle);
		});
	}, [library, query, type]);
	const visible = filtered.slice(0, 180);
	const chosen = preferences.source !== "none" && (preferences.source === "image" ? Boolean(preferences.imageId) : Boolean(preferences.engineId));

	if (!desktop) {
		return (
			<SettingsGroup title={t("settings.appearance.group.wallpaper")}>
				<SettingsRow hint={t("settings.wallpaper.desktopOnly")} label={t("settings.wallpaper.source")}>
					<span />
				</SettingsRow>
			</SettingsGroup>
		);
	}

	return (
		<SettingsGroup title={t("settings.appearance.group.wallpaper")}>
			<SettingsRow hint={t("settings.wallpaper.sourceHint")} label={t("settings.wallpaper.source")}>
				<Segmented
					onChange={(source) => updatePreferences({ source })}
					options={SOURCES.map((id) => ({ id, label: t(SOURCE_KEYS[id]) }))}
					value={preferences.source}
				/>
			</SettingsRow>

			{preferences.source === "image" ? (
				<>
					<SettingsRow hint={t("settings.wallpaper.imageHint")} label={t("settings.wallpaper.image")}>
						<Button onClick={() => void upload()} size="sm" variant="subtle">
							{t("settings.wallpaper.upload")}
						</Button>
					</SettingsRow>
					{uploads.length > 0 && origin ? (
						<div className="flex flex-wrap gap-2 py-2">
							{uploads.map((item) => {
								const selected = preferences.imageId === item.id;
								return (
									<div key={item.id} className="relative">
										<button
											type="button"
											title={item.name}
											onClick={() => updatePreferences({ source: "image", imageId: item.id })}
											className={cn(
												"block h-14 w-24 overflow-hidden rounded-lg border border-[color:var(--color-border)]",
												selected && "ring-2 ring-[color:var(--color-border-heavy)]",
											)}
										>
											<img alt={item.name} className="h-full w-full object-cover" src={wallpaperUploadUrl(origin.base, item.id)} />
										</button>
										<button
											type="button"
											aria-label={t("settings.wallpaper.remove")}
											className="absolute right-0.5 top-0.5 rounded-full bg-black/55 p-0.5 text-white"
											onClick={() => void removeUpload(item.id)}
										>
											<XIcon className="size-3" />
										</button>
									</div>
								);
							})}
						</div>
					) : (
						<p className="py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("settings.wallpaper.empty")}</p>
					)}
				</>
			) : null}

			{preferences.source === "engine" ? (
				<SettingsRow
					hint={preferences.engineTitle || (library && !library.installed ? t("settings.wallpaper.notInstalled") : t("settings.wallpaper.noneSelected"))}
					label={t("settings.wallpaper.engine")}
				>
					<Button onClick={() => void openLibrary(false)} size="sm" variant="subtle">
						{t("settings.wallpaper.choose")}
					</Button>
				</SettingsRow>
			) : null}

			{chosen ? (
				<>
					<SettingsRow hint={t("settings.wallpaper.fitHint")} label={t("settings.wallpaper.fit")}>
						<Segmented
							onChange={(fit) => updatePreferences({ fit })}
							options={FITS.map((id) => ({ id, label: t(FIT_KEYS[id]) }))}
							value={preferences.fit}
						/>
					</SettingsRow>
					<SettingsRow hint={t("settings.wallpaper.strengthHint")} label={t("settings.wallpaper.strength")}>
						<Slider label={t("settings.wallpaper.strength")} max={100} onChange={(strength) => updatePreferences({ strength })} value={preferences.strength} />
					</SettingsRow>
					<SettingsRow hint={t("settings.wallpaper.blurHint")} label={t("settings.wallpaper.blur")}>
						<Slider label={t("settings.wallpaper.blur")} max={40} onChange={(blur) => updatePreferences({ blur })} value={preferences.blur} />
					</SettingsRow>
					<SettingsRow hint={t("settings.wallpaper.dimHint")} label={t("settings.wallpaper.dim")}>
						<Slider label={t("settings.wallpaper.dim")} max={80} onChange={(dim) => updatePreferences({ dim })} value={preferences.dim} />
					</SettingsRow>
					{preferences.source === "engine" ? (
						<SettingsRow hint={t("settings.wallpaper.mutedHint")} label={t("settings.wallpaper.muted")}>
							<Switch checked={preferences.muted} onCheckedChange={(muted) => updatePreferences({ muted })} />
						</SettingsRow>
					) : null}
				</>
			) : null}

			{error ? <p className="py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p> : null}

			{picking ? (
				<WallpaperLibraryDialog
					error={libraryError}
					library={library}
					loading={loadingLibrary}
					onClose={() => setPicking(false)}
					onRefresh={() => void openLibrary(true)}
					onSelect={(entry) => {
						updatePreferences({ source: "engine", engineId: entry.id, engineTitle: entry.title });
						setPicking(false);
					}}
					origin={origin}
					query={query}
					selectedId={preferences.engineId}
					setQuery={setQuery}
					setType={setType}
					type={type}
					visible={visible}
					hiddenCount={Math.max(0, filtered.length - visible.length)}
				/>
			) : null}
		</SettingsGroup>
	);
}

function WallpaperLibraryDialog({
	library,
	loading,
	error,
	origin,
	query,
	setQuery,
	type,
	setType,
	visible,
	hiddenCount,
	selectedId,
	onSelect,
	onRefresh,
	onClose,
}: {
	library: WallpaperLibrary | null;
	loading: boolean;
	error: string | null;
	origin: WallpaperOrigin | null;
	query: string;
	setQuery: (value: string) => void;
	type: (typeof TYPES)[number];
	setType: (value: (typeof TYPES)[number]) => void;
	visible: WallpaperEntry[];
	hiddenCount: number;
	selectedId: string | null;
	onSelect: (entry: WallpaperEntry) => void;
	onRefresh: () => void;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const description = library?.installDir || (library && !library.installed ? t("settings.wallpaper.notInstalled") : undefined);
	return (
		<SettingsDialog
			wide
			title={t("settings.wallpaper.choose")}
			description={description}
			onClose={onClose}
			footer={
				<>
					<Button className="mr-auto" onClick={onRefresh} size="sm" variant="subtle">
						{t("settings.wallpaper.refresh")}
					</Button>
					<Button onClick={onClose} size="sm">
						{t("common.close")}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-2">
				<input
					aria-label={t("settings.wallpaper.search")}
					className="w-full rounded-lg border border-[color:var(--color-border)] bg-transparent px-2 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] outline-none placeholder:text-muted-foreground/50 focus:border-[color:var(--color-border-focus)]"
					onChange={(event) => setQuery(event.currentTarget.value)}
					placeholder={t("settings.wallpaper.search")}
					value={query}
				/>
				<Segmented onChange={setType} options={TYPES.map((id) => ({ id, label: t(TYPE_KEYS[id]) }))} value={type} />
			</div>
			{loading ? <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("settings.wallpaper.scanning")}</p> : null}
			{error ? <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p> : null}
			{!loading && visible.length === 0 ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("settings.wallpaper.emptyLibrary")}</p>
			) : (
				<div className="grid grid-cols-3 gap-2">
					{visible.map((entry) => {
						const unsupported = entry.type === "application";
						const selected = selectedId === entry.id;
						return (
							<button
								key={entry.id}
								type="button"
								disabled={unsupported}
								title={unsupported ? t("settings.wallpaper.application") : entry.title}
								onClick={() => onSelect(entry)}
								className={cn(
									"relative aspect-video overflow-hidden rounded-lg border border-[color:var(--color-border)] text-left",
									unsupported && "cursor-not-allowed opacity-50",
									selected && "ring-2 ring-[color:var(--color-border-heavy)]",
								)}
								style={{ background: entry.schemeColor ?? "var(--color-background-elevated-secondary)" }}
							>
								{entry.hasPreview && origin ? (
									<img alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" src={wallpaperPreviewUrl(origin.base, entry.id)} />
								) : null}
								<span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-1 text-[length:var(--app-font-size-ui-xs,10px)] text-white">
									{entry.title}
								</span>
								<span className="absolute left-1 top-1 rounded bg-black/55 px-1 text-[9px] text-white">{typeLabel(entry.type, t)}</span>
								{selected ? (
									<span className="absolute right-1 top-1 rounded-full bg-black/55 p-0.5 text-white">
										<CheckIcon className="size-3" />
									</span>
								) : null}
							</button>
						);
					})}
				</div>
			)}
			{hiddenCount > 0 ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{t("settings.wallpaper.more", { count: hiddenCount })}
				</p>
			) : null}
			{origin && !origin.live ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("settings.wallpaper.liveUnavailable")}</p>
			) : null}
		</SettingsDialog>
	);
}
