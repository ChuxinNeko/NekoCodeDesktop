import { useState } from "react";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import type { TurnDiffRequest } from "../../lib/turnChanges";
import { RefreshCwIcon } from "../../lib/icons";
import { DiffViewer } from "../review/DiffViewer";
import { useAsync, useDiffPrefs } from "../review/hooks";
import { IconButton } from "../ui/icon-button";

/** The originating turn's changes, independent of Git's staged/unstaged split. */
export function TurnDiffPanel({ request }: { request: TurnDiffRequest | null }) {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useDiffPrefs();
  const [selection, setSelection] = useState<{ nonce: number; path: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const files = request?.checkpoint.files ?? [];
  const selected = selection?.nonce === request?.nonce ? selection?.path : request?.path;
  const file = files.find(file => file.path === selected) ?? files[0];
  const checkpointId = request?.checkpoint.id;
  const diff = useAsync(checkpointId && file ? () => api.checkpointFileDiff(checkpointId, file.path) : null,
    [checkpointId, file?.path, file?.additions, file?.deletions, request?.nonce, revision], `${checkpointId}:${file?.path}`);

  return <section className="flex min-h-0 flex-1 flex-col" aria-label={t("fileEdit.changes")}>
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
      <h2 className="min-w-0 flex-1 truncate text-[12px] font-medium">{t("fileEdit.changes")}</h2>
      <span className="text-[10px] text-muted-foreground">{t("fileEdit.capsuleSummary", { count: files.length })}</span>
      <IconButton label={t("common.refresh")} onClick={() => setRevision(value => value + 1)} disabled={!file || diff.loading}><RefreshCwIcon className="size-3.5" /></IconButton>
    </header>
    {request && file ? <div className="shrink-0 border-b border-[color:var(--app-surface-divider)] px-3 py-2">
      <select aria-label={t("fileEdit.selectDiffFile")} value={file.path}
        onChange={event => setSelection({ nonce: request.nonce, path: event.target.value })}
        className="w-full min-w-0 rounded-lg border border-border/60 bg-transparent px-2 py-1.5 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring">
        {files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
      </select>
    </div> : null}
    {diff.error ? <p role="alert" className="px-3 py-3 text-[12px] text-destructive">{diff.error}</p> :
      diff.data?.binary ? <p className="px-3 py-4 text-[12px] text-muted-foreground">{t("checkpoint.binaryHint")}</p> :
      <DiffViewer patch={diff.data?.patch ?? ""} path={file?.path ?? null} loading={diff.loading}
        prefs={{ ...prefs, ignoreWhitespace: false }} onPrefs={next => setPrefs({ ...prefs, mode: next.mode })} hideWhitespaceToggle />}
  </section>;
}
