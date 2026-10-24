import { useRef, useState } from "react";
import type { SessionSummary } from "../../../../shared/agent";
import { errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ConfirmDialog } from "../ui/confirm-dialog";

export function SessionDeleteDialog({ session, onClose, onDelete }: {
	session: SessionSummary;
	onClose: () => void;
	onDelete: (session: SessionSummary, deleteFromCli?: boolean) => Promise<boolean | void>;
}) {
	const { t } = useTranslation();
	const [deleteFromCli, setDeleteFromCli] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef(false);
	const confirm = async () => {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setError(null);
		try {
			await onDelete(session, !!session.agentId && deleteFromCli);
			onClose();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	};
	return <ConfirmDialog open onOpenChange={(open) => { if (!open && !pending.current) onClose(); }}
		title={t("sessions.deleteConfirm", { title: session.titlePending ? t("sessions.pendingTitle") : session.title })}
		description={t(session.agentId ? "sessions.acpDeleteHint" : "sessions.deleteHint")}
		footer={<>
			<Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
			<Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => void confirm()}>{t(busy ? "sessions.deleting" : "common.delete")}</Button>
		</>}>
		{session.agentId ? <>
			<label className="flex cursor-pointer items-center gap-2 text-sm">
				<Checkbox checked={deleteFromCli} disabled={busy} onCheckedChange={(checked) => setDeleteFromCli(checked === true)} />
				{t("sessions.deleteFromCli")}
			</label>
			{deleteFromCli ? <p className="text-xs text-destructive">{t("sessions.deleteFromCliHint")}</p> : null}
		</> : null}
		{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
	</ConfirmDialog>;
}
