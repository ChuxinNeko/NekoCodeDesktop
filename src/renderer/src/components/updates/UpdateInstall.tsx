import { useEffect, useState } from "react";
import type { AppRelease, UpdateInstallState } from "../../../../shared/updates";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { DownloadIcon, ExternalLinkIcon, RefreshCwIcon } from "../../lib/icons";
import { Button } from "../ui/button";

/** The host's in-app install state, shared by every window; null until it answers. */
export function useUpdateInstallState(): UpdateInstallState | null {
	const [state, setState] = useState<UpdateInstallState | null>(null);
	useEffect(() => {
		let active = true;
		const off = api.onUpdateInstallState(setState);
		api.updateInstallState()
			.then((value) => { if (active) setState(value); })
			.catch(() => { if (active) setState({ phase: "unsupported" }); });
		return () => { active = false; off(); };
	}, []);
	return state;
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Download-and-restart for a newer release where the host can install it in
 * place; elsewhere, and as the way out of a failed download, the release page.
 * Rendered as items of the caller's wrapping flex row.
 */
export function UpdateInstallActions({ release, state, onOpen }: {
	release: AppRelease;
	state: UpdateInstallState | null;
	onOpen: (url: string) => void;
}) {
	const { t } = useTranslation();
	const [error, setError] = useState<string | null>(null);
	const openPage = (primary: boolean) => (
		<Button size="sm" variant={primary ? "default" : "chrome-outline"} onClick={() => onOpen(release.url)}>
			<ExternalLinkIcon className="size-3.5" />{t("updates.download")}
		</Button>
	);
	if (!state || state.phase === "unsupported") return openPage(true);
	const download = () => {
		setError(null);
		void api.downloadUpdate(release.tag).catch((cause) => setError(errorMessage(cause)));
	};
	const install = () => {
		setError(null);
		void api.installUpdate().catch((cause) => setError(errorMessage(cause)));
	};
	const failure = error ?? (state.phase === "error" && state.version === release.version ? state.message : null);
	const alert = failure
		? <p role="alert" className="basis-full break-words text-xs text-destructive">{t("updates.install.failed", { message: failure })}</p>
		: null;

	if (state.phase === "installing") {
		return <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
			<RefreshCwIcon className="size-3.5 animate-spin" />
			<span>{t("updates.install.installing")}</span>
		</div>;
	}

	if (state.phase === "downloading") {
		const percent = state.total > 0 ? Math.min(100, Math.round((state.transferred / state.total) * 100)) : 0;
		return (
			<div className="flex min-w-48 flex-1 flex-col gap-1.5" aria-live="polite">
				<span className="text-xs text-muted-foreground">
					{state.total > 0
						? t("updates.install.downloading", { version: state.version, transferred: megabytes(state.transferred), total: megabytes(state.total) })
						: t("updates.install.preparing", { version: state.version })}
				</span>
				<div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 overflow-hidden rounded-full bg-muted">
					<div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
				</div>
			</div>
		);
	}
	if (state.phase === "downloaded" && state.version === release.version) {
		return (
			<>
				{alert}
				<span className="text-xs text-muted-foreground">{t("updates.install.ready")}</span>
				<Button size="sm" onClick={install}>
					<RefreshCwIcon className="size-3.5" />{t("updates.install.restart")}
				</Button>
			</>
		);
	}
	return (
		<>
			{alert}
			{openPage(false)}
			<Button size="sm" onClick={download}>
				<DownloadIcon className="size-3.5" />{failure ? t("updates.install.retry") : t("updates.install.download")}
			</Button>
		</>
	);
}
