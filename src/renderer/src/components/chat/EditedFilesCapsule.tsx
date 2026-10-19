import { Popover } from "@base-ui/react/popover";
import { useState } from "react";
import type { CheckpointSummary } from "../../../../shared/checkpoints";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { DiffStat } from "../ui/diff-stat";
import { COMPOSER_FLOATING_CONTROL_CLASS_NAME } from "./composerPickerStyles";

function fileName(path: string) { return path.replace(/\\/g, "/").split("/").pop() || path; }

/** A summary at rest; a collision-aware file list on hover, never an inline patch. */
export function EditedFilesCapsule({ checkpoint, onOpenDiff, onReview }: {
  checkpoint: CheckpointSummary;
  onOpenDiff?: (path: string) => void;
  onReview?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const canOpen = !!(onOpenDiff || onReview);
  const openDiff = (path: string) => {
    setOpen(false);
    if (onOpenDiff) onOpenDiff(path); else onReview?.();
  };
  const names = new Map<string, number>();
  for (const file of checkpoint.files) names.set(fileName(file.path), (names.get(fileName(file.path)) ?? 0) + 1);

  return <div className="absolute bottom-2 left-1/2 z-30 max-w-full -translate-x-1/2">
    <Popover.Root open={open} onOpenChange={(next, details) => {
      // A press opens the dock; hover/focus opens the lightweight list.
      if (details.reason === "trigger-press" && canOpen) { details.cancel(); return; }
      setOpen(next);
    }}>
      <Popover.Trigger openOnHover delay={140} closeDelay={180} onFocus={() => setOpen(true)}
        onClick={() => { if (canOpen && checkpoint.files[0]) openDiff(checkpoint.files[0].path); }}
        aria-label={t("fileEdit.changes")} data-slot="edited-files" data-live="true"
        className={cn(COMPOSER_FLOATING_CONTROL_CLASS_NAME,
          "flex h-7 w-fit max-w-full cursor-pointer items-center gap-2 px-3 text-[length:var(--app-font-size-ui,12px)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}>
        <span className="min-w-0 truncate">{t("fileEdit.capsuleSummary", { count: checkpoint.files.length })}</span>
        <DiffStat animate className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)]" insertions={checkpoint.additions} deletions={checkpoint.deletions} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="center" sideOffset={8} collisionPadding={12}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "start" }} className="z-[80]">
          <Popover.Popup initialFocus={false} finalFocus={false} aria-label={t("fileEdit.changes")} data-live-preview=""
            className="edited-files-popover w-[min(21rem,var(--available-width))] overflow-hidden rounded-2xl border border-border/60 shadow-xl outline-none">
            <div className="max-h-[min(22rem,var(--available-height))] overflow-y-auto overscroll-contain p-1.5" role="list" aria-label={t("fileEdit.changes")}>
              {checkpoint.files.map(file => {
                const name = fileName(file.path);
                const content = <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{name}</span>
                    {(names.get(name) ?? 0) > 1 ? <span className="block truncate text-[10px] text-muted-foreground">{file.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/") || "."}</span> : null}
                  </span>
                  <DiffStat animate className="shrink-0 text-[11px]" insertions={file.additions} deletions={file.deletions} />
                </>;
                const className = "flex w-full items-center gap-4 rounded-xl px-3 py-2.5 text-left text-[12px] outline-none transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring";
                return <div key={file.path} role="listitem">{canOpen ?
                  <button type="button" className={cn(className, "cursor-pointer")} title={file.path} onClick={() => openDiff(file.path)}>{content}</button> :
                  <div className={className} title={file.path}>{content}</div>}
                </div>;
              })}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}
