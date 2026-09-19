import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { ExternalLinkIcon } from "../../lib/icons";
import { scheduleStartupUpdate, type UpdateNotice } from "../../lib/startupUpdate";
import { Button } from "../ui/button";
import { ReleaseNotes } from "./ReleaseNotes";

export function UpdateDialog({ notice, onClose, deferred = false }: {
	notice: UpdateNotice | null;
	onClose: () => void;
	deferred?: boolean;
}) {
	const { t, language } = useTranslation();
	const [error, setError] = useState<string | null>(null);
	const [opening, setOpening] = useState(false);
	const openLink = async (url: string, close = false) => {
		setError(null);
		setOpening(true);
		try {
			await api.openExternal(url);
			if (close) onClose();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setOpening(false);
		}
	};
	if (!notice) return null;
	const { release, currentVersion } = notice;
	return (
		<Dialog.Root open={!deferred} onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px]" />
				<Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-3rem)] w-[36rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl outline-none">
					<div className="shrink-0 space-y-1.5">
						<Dialog.Title className="text-base font-semibold">{t("updates.available", { version: release.version })}</Dialog.Title>
						<Dialog.Description className="text-xs text-muted-foreground">{t("updates.upgradeFrom", { current: currentVersion, latest: release.version })}</Dialog.Description>
						{release.publishedAt ? <p className="text-xs text-muted-foreground">{t("updates.publishedAt", { date: new Date(release.publishedAt).toLocaleDateString(language) })}</p> : null}
					</div>
					<div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-muted/20 p-3">
						<h3 className="mb-3 text-sm font-medium">{t("updates.notes")}</h3>
						<ReleaseNotes notes={release.notes} onOpen={(url) => void openLink(url)} />
					</div>
					{error ? <p role="alert" className="shrink-0 text-xs text-destructive">{error}</p> : null}
					<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
						<Button size="sm" variant="chrome-outline" onClick={onClose}>{t("updates.later")}</Button>
						<Button size="sm" onClick={() => void openLink(release.url, true)} disabled={opening}>
							<ExternalLinkIcon className="size-3.5" />{t("updates.download")}
						</Button>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** Mounted at the window root, so navigating between pages never rechecks or reopens it. */
export function AutomaticUpdateDialog({ deferred = false }: { deferred?: boolean }) {
	const [notice, setNotice] = useState<UpdateNotice | null>(null);
	useEffect(() => scheduleStartupUpdate(() => api.checkForUpdatesOnStartup(), setNotice), []);
	const dismiss = () => {
		setNotice(null);
		void api.dismissStartupUpdate().catch(() => {});
	};
	return <UpdateDialog notice={notice} onClose={dismiss} deferred={deferred} />;
}
