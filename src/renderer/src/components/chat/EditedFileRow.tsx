import { Popover } from "@base-ui/react/popover";
import { useState } from "react";
import type { CheckpointEditedFile } from "../../../../shared/checkpoints";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import CodeBlock from "../CodeBlock";
import { codeBlockDiff } from "../../lib/codeBlockDiff";
import { useAsync } from "../review/hooks";
import { DiffStat } from "../ui/diff-stat";

/** Fetch only while a preview is visible; unmounting cancels stale responses. */
export function EditedFilePreview({ checkpointId, file }: { checkpointId: string; file: CheckpointEditedFile }) {
	const { t } = useTranslation();
	const diff = useAsync(() => api.checkpointFileDiff(checkpointId, file.path),
		[checkpointId, file.path, file.additions, file.deletions], `${checkpointId}:${file.path}`);
	if (diff.loading) return <p role="status">{t("checkpoint.loadingPreview")}</p>;
	if (diff.error) return <p role="alert">{diff.error}</p>;
	if (diff.data?.binary) return <p>{t("checkpoint.binaryHint")}</p>;
	return <CodeBlock variant="Diff" filename={file.path} diff={codeBlockDiff(diff.data?.patch ?? "")} code={diff.data?.patch ?? ""}
		maxHeight="min(30rem, var(--available-height))" />;
}

/** The whole filename row is the hover target and the dock navigation target. */
export function EditedFileRow({ checkpointId, file, onOpenDiff }: {
	checkpointId: string;
	file: CheckpointEditedFile;
	onOpenDiff?: (path: string) => void;
}) {
	const [open, setOpen] = useState(false);
	return <Popover.Root open={open} onOpenChange={(next, details) => {
		if (details.reason === "trigger-press" && onOpenDiff) { details.cancel(); return; }
		setOpen(next);
	}}>
		<Popover.Trigger openOnHover delay={180} closeDelay={150} onFocus={() => setOpen(true)}
			onClick={() => { if (onOpenDiff) { setOpen(false); onOpenDiff(file.path); } }}
			className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left text-[length:var(--app-font-size-ui,12px)] transition-colors hover:bg-[var(--sidebar-accent)] data-[popup-open]:bg-[var(--sidebar-accent)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			data-slot="edited-file-row">
			<span className="min-w-0 flex-1 truncate">{file.path}</span>
			<DiffStat className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)]" insertions={file.additions} deletions={file.deletions} />
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Positioner side="top" align="center" sideOffset={8} collisionPadding={12}
				collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "start" }} className="z-[80]">
				<Popover.Popup initialFocus={false} finalFocus={false} aria-label={file.path} data-slot="edited-file-preview"
					className="beautiful-agent-screen w-[min(26.25rem,var(--available-width))] outline-none">
					{open ? <EditedFilePreview checkpointId={checkpointId} file={file} /> : null}
				</Popover.Popup>
			</Popover.Positioner>
		</Popover.Portal>
	</Popover.Root>;
}
