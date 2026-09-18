import { useEffect, useRef, useState } from "react";
import {
	isPluginSource,
	type PluginScope,
	type PluginSummary,
	type PluginsSnapshot,
} from "../../../../shared/plugins";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { PluginCatalog } from "./PluginCatalog";

const EMPTY: PluginsSnapshot = { plugins: [], errors: [], busy: false };

function PluginRow({
	plugin,
	busy,
	onToggle,
	onRemove,
	onUpdate,
}: {
	plugin: PluginSummary;
	busy: boolean;
	onToggle: (enabled: boolean) => void;
	onRemove: () => void;
	onUpdate: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col gap-1 rounded-lg border border-border p-3">
			<div className="flex items-center gap-2">
				<input
					type="checkbox"
					id={"plugin-" + plugin.scope + ":" + plugin.source}
					checked={plugin.enabled}
					disabled={busy || !plugin.installedPath}
					onChange={(event) => onToggle(event.target.checked)}
				/>
				<label
					htmlFor={"plugin-" + plugin.scope + ":" + plugin.source}
					className="min-w-0 flex-1 cursor-pointer break-all font-medium"
				>
					{plugin.source}
				</label>
				<span
					className={cn(
						"shrink-0 rounded-full border border-border/60 px-1.5",
						"text-[length:var(--app-font-size-ui-sm,11px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					{t(
						plugin.scope === "project"
							? "plugins.scope.project"
							: "plugins.scope.user",
					)}
				</span>
				<Button size="xs" variant="ghost" disabled={busy} onClick={onUpdate}>
					{t("plugins.update")}
				</Button>
				<Button size="xs" variant="outline" disabled={busy} onClick={onRemove}>
					{t("plugins.remove")}
				</Button>
			</div>
			{!plugin.installedPath ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
					{t("plugins.notInstalled")}
				</p>
			) : null}
			{plugin.tools.length ? (
				<p
					className={cn(
						"break-all text-[length:var(--app-font-size-ui-sm,11px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					{t("plugins.registeredTools")}: <code>{plugin.tools.join(", ")}</code>
				</p>
			) : plugin.installedPath ? (
				<p
					className={cn(
						"text-[length:var(--app-font-size-ui-sm,11px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					{t("plugins.noTools")}
				</p>
			) : null}
			{plugin.error ? (
				<p className="whitespace-pre-wrap break-all text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					{plugin.error}
				</p>
			) : null}
		</div>
	);
}

/**
 * Install, enable, and remove pi packages.
 *
 * The two states a row carries are not the same thing: installed is pi's, and
 * lives in its settings so the CLI keeps working on the same packages; enabled
 * is this app's, and is what lets the model call the package's tools. Landing a
 * package on disk is not authorizing it, so a fresh install starts off — and
 * the row shows exactly which tools turning it on would admit.
 */
export function PluginSettings() {
	const { t } = useTranslation();
	const [snapshot, setSnapshot] = useState<PluginsSnapshot>(EMPTY);
	const [source, setSource] = useState("");
	const [scope, setScope] = useState<PluginScope>("user");
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<"catalog" | "installed" | "manual">("catalog");
	const [pending, setPending] = useState(false);
	const [ready, setReady] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const actionInFlight = useRef(false);
	const busy = snapshot.busy || pending || !ready;

	useEffect(() => {
		let active = true;
		let receivedEvent = false;
		const unsubscribe = api.onPluginsChanged((value) => {
			receivedEvent = true;
			if (active) {
				setSnapshot(value);
				setReady(true);
			}
		});
		api
			.pluginsList()
			.then((value) => {
				if (active && !receivedEvent) {
					setSnapshot(value);
					setReady(true);
				}
			})
			.catch((cause: unknown) => {
				if (active) setError(errorMessage(cause));
			});
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);

	const act = async (action: () => Promise<PluginsSnapshot>) => {
		if (actionInFlight.current || busy) return false;
		actionInFlight.current = true;
		setPending(true);
		setError(null);
		setMessage(null);
		try {
			setSnapshot(await action());
			return true;
		} catch (cause) {
			setError(errorMessage(cause));
			return false;
		} finally {
			actionInFlight.current = false;
			setPending(false);
		}
	};

	const install = async (value: string) => {
		if (await act(() => api.pluginsInstall({ source: value.trim(), scope }))) {
			setSource("");
			setMessage(t("plugins.installedMessage", { name: value.trim() }));
		}
	};

	const valid = isPluginSource(source);

	return (
		<div className="@container flex flex-col gap-4 text-[length:var(--app-font-size-ui,12px)]">
			<p
				className={cn(
					"text-[length:var(--app-font-size-ui-sm,11px)]",
					MUTED_LABEL_TEXT_CLASS_NAME,
				)}
			>
				{t("plugins.intro")}
			</p>

			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
				<div className="flex gap-1" aria-label={t("settings.section.plugins")}>
					{(["catalog", "installed", "manual"] as const).map((value) => (
						<Button
							key={value}
							size="xs"
							variant={tab === value ? "secondary" : "ghost"}
							aria-pressed={tab === value}
							onClick={() => setTab(value)}
						>
							{t(`plugins.tab.${value}`)}
							{value === "installed" ? ` (${snapshot.plugins.length})` : ""}
						</Button>
					))}
				</div>
				{tab !== "installed" ? (
					<label className="flex items-center gap-2 text-muted-foreground">
						{t("plugins.scopeLabel")}
						<select
							className="h-7 rounded-md border border-border bg-background px-2 text-foreground"
							value={scope}
							disabled={busy}
							onChange={(event) => setScope(event.target.value as PluginScope)}
						>
							<option value="user">{t("plugins.scope.user")}</option>
							<option value="project">{t("plugins.scope.project")}</option>
						</select>
					</label>
				) : null}
			</div>

			{tab === "manual" ? (
				<div className="flex flex-col gap-2">
					<div className="flex gap-2">
						<Input
							className="min-w-0 flex-1"
							placeholder="npm:@scope/pkg  ·  git:github.com/user/repo@v1  ·  ./local/path"
							value={source}
							aria-label={t("plugins.tab.manual")}
							disabled={busy}
							onChange={(event) => setSource(event.target.value)}
							onKeyDown={(event) => {
								if (event.key !== "Enter" || !valid || busy) return;
								void install(source);
							}}
						/>
						<Button
							size="xs"
							variant="prominent"
							disabled={!valid || busy}
							onClick={() => void install(source)}
						>
							{t("plugins.install")}
						</Button>
					</div>
					{source && !valid ? (
						<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
							{t("plugins.badSource")}
						</p>
					) : null}
				</div>
			) : null}

			{snapshot.busy || pending ? (
				<p
					className={cn(
						"flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)]",
						MUTED_LABEL_TEXT_CLASS_NAME,
					)}
				>
					<Spinner className="size-3.5" />
					{t("plugins.working")}
				</p>
			) : null}
			{message ? (
				<p role="status" className="text-muted-foreground">
					{message}
				</p>
			) : null}

			{error ? (
				<p role="alert" className="whitespace-pre-wrap text-destructive">
					{error}
				</p>
			) : null}

			<div hidden={tab !== "catalog"}>
				<PluginCatalog
					plugins={snapshot.plugins}
					scope={scope}
					busy={busy}
					onInstall={(value) => void install(value)}
				/>
			</div>

			{tab === "installed" ? (
				<>
					{!ready && !error ? (
						<p role="status">{t("common.loading")}…</p>
					) : null}
					{ready && snapshot.plugins.length === 0 && !busy ? (
						<p
							className={cn(
								"text-[length:var(--app-font-size-ui-sm,11px)]",
								MUTED_LABEL_TEXT_CLASS_NAME,
							)}
						>
							{t("plugins.empty")}
						</p>
					) : null}

					<div className="flex flex-col gap-2">
						{snapshot.plugins.map((plugin) => (
							<PluginRow
								key={plugin.scope + ":" + plugin.source}
								plugin={plugin}
								busy={busy}
								onToggle={(enabled) =>
									void act(() =>
										api.pluginsSetEnabled({
											source: plugin.source,
											scope: plugin.scope,
											enabled,
										}),
									)
								}
								onRemove={() =>
									void act(() =>
										api.pluginsRemove({
											source: plugin.source,
											scope: plugin.scope,
										}),
									)
								}
								onUpdate={() =>
									void act(() => api.pluginsUpdate(plugin.source))
								}
							/>
						))}
					</div>

					{snapshot.errors.length ? (
						<div className="flex flex-col gap-1">
							<span
								className={cn(
									"text-[length:var(--app-font-size-ui-sm,11px)]",
									MUTED_LABEL_TEXT_CLASS_NAME,
								)}
							>
								{t("plugins.looseErrors")}
							</span>
							{snapshot.errors.map((entry) => (
								<p
									key={entry}
									className="whitespace-pre-wrap break-all text-[length:var(--app-font-size-ui-sm,11px)] text-destructive"
								>
									{entry}
								</p>
							))}
						</div>
					) : null}
				</>
			) : null}

			<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
				{t("plugins.warning")}
			</p>
		</div>
	);
}
