import { useEffect, useState } from "react";
import type { AppVersionInfo, UpdateCheckResult } from "../../../../shared/updates";
import { RELEASES_URL, UPDATE_REPOSITORY } from "../../../../shared/updates";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { ExternalLinkIcon, RefreshCwIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import { ReleaseNotes } from "../updates/ReleaseNotes";

interface AboutSettingsViewProps {
	info: AppVersionInfo | null;
	result: UpdateCheckResult | null;
	busy: boolean;
	loading: boolean;
	error: string | null;
	onCheck: () => void;
	onOpen: (url: string) => void;
}

export function AboutSettingsView({ info, result, busy, loading, error, onCheck, onOpen }: AboutSettingsViewProps) {
	const { t, language } = useTranslation();
	const release = result && "release" in result ? result.release : null;
	return (
		<section className="flex flex-col gap-4">
			<div className="rounded-xl border border-border bg-muted/20 p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex items-center gap-3">
						<img src="./icon.png" alt="" aria-hidden="true" draggable={false} className="size-12 shrink-0" />
						<div className="space-y-1">
							<h3 className="text-base font-semibold">NekoCode Desktop</h3>
							<p className="text-xs text-muted-foreground">
								{t("updates.currentVersion")} <span className="font-mono text-foreground">{info ? `v${info.version}` : "—"}</span>
								{info?.development ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5">{t("updates.development")}</span> : null}
							</p>
						</div>
					</div>
					<Button size="sm" variant="chrome-outline" onClick={onCheck} disabled={busy || loading}>
						<RefreshCwIcon className={busy ? "size-3.5 animate-spin" : "size-3.5"} />
						{busy ? t("updates.checking") : t("updates.check")}
					</Button>
				</div>
				<p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t("updates.description")}</p>
			</div>

			<div aria-live="polite" aria-busy={busy} className="space-y-2 text-xs">
				{error ? <p role="alert" className="text-destructive">{error}</p> : null}
				{result && !busy ? (
					<>
						<p className={result.status === "error" ? "text-destructive" : result.status === "available" ? "font-medium text-primary" : "text-muted-foreground"}>
							{result.status === "error" ? t(`updates.error.${result.error}`) : t(`updates.${result.status}`, { version: release?.version ?? "" })}
						</p>
						<p className="text-muted-foreground">{t("updates.checkedAt", { time: new Date(result.checkedAt).toLocaleString(language) })}</p>
					</>
				) : null}
			</div>

			{release && !busy ? (
				<div className="space-y-3 rounded-xl border border-border p-4">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="min-w-0 space-y-1">
							<h3 className="break-words text-sm font-medium">{release.name}</h3>
							<p className="text-xs text-muted-foreground">
								{t("updates.latestVersion")} <span className="font-mono">v{release.version}</span>
								{release.publishedAt ? ` · ${new Date(release.publishedAt).toLocaleDateString(language)}` : ""}
							</p>
						</div>
						<Button size="sm" variant={result?.status === "available" ? "default" : "chrome-outline"} onClick={() => onOpen(release.url)}>
							<ExternalLinkIcon className="size-3.5" />
							{result?.status === "available" ? t("updates.download") : t("updates.viewRelease")}
						</Button>
					</div>
					<div className="space-y-2 border-t border-border pt-3">
						<h4 className="text-xs font-medium">{t("updates.notes")}</h4>
						<div className="max-h-72 overflow-y-auto"><ReleaseNotes notes={release.notes} onOpen={onOpen} /></div>
					</div>
				</div>
			) : null}

			<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
				<span>{UPDATE_REPOSITORY}</span>
				<Button size="sm" variant="ghost" onClick={() => onOpen(info?.releasesUrl ?? RELEASES_URL)}>
					<ExternalLinkIcon className="size-3.5" /> GitHub Releases
				</Button>
			</div>
		</section>
	);
}

export function AboutSettings() {
	const [info, setInfo] = useState<AppVersionInfo | null>(null);
	const [result, setResult] = useState<UpdateCheckResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let active = true;
		api.appVersion().then((value) => { if (active) setInfo(value); })
			.catch((cause) => { if (active) setError(errorMessage(cause)); })
			.finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, []);
	const check = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		setResult(null);
		try {
			if (!info) setInfo(await api.appVersion());
			setResult(await api.checkForUpdates());
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	const open = (url: string) => {
		setError(null);
		void api.openExternal(url).catch((cause) => setError(errorMessage(cause)));
	};
	return <AboutSettingsView info={info} result={result} busy={busy} loading={loading} error={error} onCheck={() => void check()} onOpen={open} />;
}
