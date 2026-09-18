import { useEffect, useRef, useState } from "react";
import {
	PLUGIN_CATALOG_URL,
	PLUGIN_TYPES,
	pluginPackageName,
	type PluginCatalogEntry,
	type PluginCatalogPage,
	type PluginCatalogSort,
	type PluginScope,
	type PluginSummary,
	type PluginType,
} from "../../../../shared/plugins";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { DownloadIcon, ExternalLinkIcon, SearchIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

export function PluginCatalogCard({
	entry,
	installed,
	busy,
	onInstall,
	onOpen,
}: {
	entry: PluginCatalogEntry;
	installed: boolean;
	busy: boolean;
	onInstall: () => void;
	onOpen: () => void;
}) {
	const { t, language } = useTranslation();
	return (
		<article className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-background/40 p-4">
			<div className="flex items-start justify-between gap-2">
				<h3 className="min-w-0 break-all font-medium leading-relaxed">
					{entry.name}
				</h3>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label={t("plugins.catalog.details", { name: entry.name })}
					onClick={onOpen}
				>
					<ExternalLinkIcon className="size-3.5" />
				</Button>
			</div>
			<p
				className="line-clamp-3 min-h-[3lh] break-words leading-relaxed text-muted-foreground"
				title={entry.description}
			>
				{entry.description || t("plugins.catalog.noDescription")}
			</p>
			<div className="flex flex-wrap gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)]">
				{entry.types.length ? (
					entry.types.map((type) => (
						<span
							key={type}
							className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground"
						>
							{t(`plugins.type.${type}`)}
						</span>
					))
				) : (
					<span className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground">
						{t("plugins.type.package")}
					</span>
				)}
			</div>
			<div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				<span className="min-w-0 truncate" title={entry.author}>
					{entry.author || t("plugins.catalog.unknownAuthor")}
				</span>
				<span
					className="inline-flex items-center gap-1"
					title={t("plugins.catalog.downloads")}
				>
					<DownloadIcon className="size-3" />
					{new Intl.NumberFormat(language, {
						notation: "compact",
						maximumFractionDigits: 1,
					}).format(entry.downloads)}
					{t("plugins.catalog.perMonth")}
				</span>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
				<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{entry.updatedAt > 0
						? new Date(entry.updatedAt).toLocaleDateString(language)
						: ""}
				</span>
				<Button
					size="xs"
					variant={installed ? "outline" : "prominent"}
					disabled={busy || installed}
					onClick={onInstall}
				>
					{t(installed ? "plugins.catalog.installed" : "plugins.install")}
				</Button>
			</div>
		</article>
	);
}

export function PluginCatalog({
	plugins,
	scope,
	busy,
	onInstall,
}: {
	plugins: PluginSummary[];
	scope: PluginScope;
	busy: boolean;
	onInstall: (source: string) => void;
}) {
	const { t } = useTranslation();
	const [search, setSearch] = useState("");
	const [type, setType] = useState<PluginType | "">("");
	const [sort, setSort] = useState<PluginCatalogSort>("downloads");
	const [page, setPage] = useState(1);
	const [revision, setRevision] = useState(0);
	const refreshedRevision = useRef(0);
	const [result, setResult] = useState<PluginCatalogPage | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [linkError, setLinkError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		// Debounce typing, and discard results from superseded searches or closed tabs.
		const timer = setTimeout(() => {
			const refresh = revision !== refreshedRevision.current;
			refreshedRevision.current = revision;
			void api.pluginsCatalog({ search, type, sort, page, refresh }).then(
				(value) => {
					if (!cancelled) {
						setResult(value);
						setLoading(false);
					}
				},
				(cause: unknown) => {
					if (!cancelled) {
						setError(errorMessage(cause));
						setLoading(false);
					}
				},
			);
		}, 250);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [search, type, sort, page, revision]);

	const open = (url: string) => {
		setLinkError(null);
		void api
			.openExternal(url)
			.catch((cause: unknown) => setLinkError(errorMessage(cause)));
	};
	const installed = new Set(
		plugins
			.filter((plugin) => plugin.scope === scope && plugin.installedPath)
			.map((plugin) => pluginPackageName(plugin.source)),
	);
	const selectClass =
		"h-8 min-w-0 rounded-md border border-border bg-background px-2";

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-muted-foreground">{t("plugins.catalog.intro")}</p>
				<Button
					size="xs"
					variant="ghost"
					onClick={() => open(PLUGIN_CATALOG_URL)}
				>
					{t("plugins.catalog.website")} <ExternalLinkIcon className="size-3" />
				</Button>
			</div>
			<div className="flex flex-wrap gap-2">
				<div className="relative min-w-48 flex-1">
					<SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						type="search"
						className="h-8 pl-8"
						aria-label={t("plugins.catalog.search")}
						placeholder={t("plugins.catalog.search")}
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setPage(1);
						}}
					/>
				</div>
				<select
					className={selectClass}
					aria-label={t("plugins.catalog.type")}
					value={type}
					onChange={(event) => {
						setType(event.target.value as PluginType | "");
						setPage(1);
					}}
				>
					<option value="">{t("plugins.catalog.allTypes")}</option>
					{PLUGIN_TYPES.map((value) => (
						<option key={value} value={value}>
							{t(`plugins.type.${value}`)}
						</option>
					))}
				</select>
				<select
					className={selectClass}
					aria-label={t("plugins.catalog.sort")}
					value={sort}
					onChange={(event) => {
						setSort(event.target.value as PluginCatalogSort);
						setPage(1);
					}}
				>
					{(["downloads", "recent", "name"] as const).map((value) => (
						<option key={value} value={value}>
							{t(`plugins.sort.${value}`)}
						</option>
					))}
				</select>
				<Button
					size="xs"
					variant="outline"
					disabled={loading}
					onClick={() => setRevision((value) => value + 1)}
				>
					{t("common.refresh")}
				</Button>
			</div>
			{linkError ? (
				<p role="alert" className="text-destructive">
					{linkError}
				</p>
			) : null}
			<div aria-live="polite" aria-busy={loading}>
				{loading ? (
					<div
						role="status"
						className="flex items-center justify-center gap-2 py-16 text-muted-foreground"
					>
						<Spinner className="size-4" />
						{t("plugins.catalog.loading")}
					</div>
				) : error ? (
					<div
						role="alert"
						className="flex flex-col items-start gap-3 rounded-lg border border-border p-4"
					>
						<p>{t("plugins.catalog.failed")}</p>
						<p className="break-all text-muted-foreground">{error}</p>
						<Button
							size="xs"
							variant="outline"
							onClick={() => setRevision((value) => value + 1)}
						>
							{t("plugins.catalog.retry")}
						</Button>
					</div>
				) : !result?.packages.length ? (
					<p className="py-16 text-center text-muted-foreground">
						{t("plugins.catalog.empty")}
					</p>
				) : (
					<div className="grid grid-cols-1 gap-3 @min-[34rem]:grid-cols-2">
						{result.packages.map((entry) => (
							<PluginCatalogCard
								key={entry.name}
								entry={entry}
								installed={installed.has(entry.name)}
								busy={busy}
								onInstall={() => onInstall(`npm:${entry.name}`)}
								onOpen={() => open(entry.url)}
							/>
						))}
					</div>
				)}
			</div>
			{!loading && !error && result && result.pages > 1 ? (
				<nav
					aria-label={t("plugins.catalog.pagination")}
					className="flex items-center justify-center gap-3"
				>
					<Button
						size="xs"
						variant="outline"
						disabled={result.page <= 1}
						onClick={() => setPage(result.page - 1)}
					>
						{t("plugins.catalog.previous")}
					</Button>
					<span className="text-muted-foreground">
						{t("plugins.catalog.page", {
							page: result.page,
							pages: result.pages,
						})}
					</span>
					<Button
						size="xs"
						variant="outline"
						disabled={result.page >= result.pages}
						onClick={() => setPage(result.page + 1)}
					>
						{t("plugins.catalog.next")}
					</Button>
				</nav>
			) : null}
		</div>
	);
}
