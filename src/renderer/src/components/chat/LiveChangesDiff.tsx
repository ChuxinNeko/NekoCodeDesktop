import { useEffect, useState } from "react";
import type { CheckpointSummary } from "../../../../shared/checkpoints";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { codeBlockDiff } from "../../lib/codeBlockDiff";
import CodeBlock from "../CodeBlock";

/** Fetch on expansion/selection, cancel stale responses when the live summary changes. */
export function LiveChangesDiff({ checkpoint, cwd }: { checkpoint: CheckpointSummary; cwd?: string | null }) {
 const { t } = useTranslation();
 const [selected, setSelected] = useState(checkpoint.files[0]?.path ?? "");
 const path = checkpoint.files.some(file => file.path === selected) ? selected : checkpoint.files[0]?.path ?? "";
 const [scope, setScope] = useState<"unstaged" | "staged">("unstaged");
 const [state, setState] = useState<{patch:string; binary:boolean; repo:boolean; error?:string} | null>(null);
 useEffect(() => {
  let cancelled = false;
  setState(null);
  if (!path) return;
  void (async () => {
   try {
    const status = cwd ? await api.gitStatus(cwd) : null;
    if (status && !status.gitAvailable) throw new Error(status.gitError || t("review.gitUnavailable"));
    const repo = status?.isRepo === true;
    const diff = repo && cwd ? {patch:await api.gitDiff({cwd, file:path, scope}),binary:false} : await api.checkpointFileDiff(checkpoint.id,path);
    if (!cancelled) setState({...diff,repo});
   } catch (cause) { if (!cancelled) setState({patch:"",binary:false,repo:false,error:errorMessage(cause)}); }
  })();
  return () => { cancelled = true; };
 }, [checkpoint.id, checkpoint.additions, checkpoint.deletions, checkpoint.files, cwd, path, scope, t]);
 const rows = codeBlockDiff(state?.patch ?? "");
 return <div className="beautiful-agent-screen min-h-0 p-2">
  <div className="mb-2 flex gap-2">
   <select aria-label={t("fileEdit.changes")} value={path} onChange={event => setSelected(event.target.value)} className="min-w-0 flex-1 rounded-md bg-background/80 p-1 text-xs">
    {checkpoint.files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
   </select>
   {state?.repo ? <select aria-label={t("review.title")} value={scope} onChange={event => setScope(event.target.value as typeof scope)} className="rounded-md bg-background/80 p-1 text-xs">
    <option value="unstaged">{t("review.scope.unstaged")}</option><option value="staged">{t("review.scope.staged")}</option>
   </select> : null}
  </div>
  <div className="max-h-[min(50vh,28rem)] overflow-auto overscroll-contain p-1 [&>div]:mx-auto">
   {!state && path ? <p role="status" className="p-3 text-xs text-muted-foreground">{t("checkpoint.loadingPreview")}</p>
    : state?.error ? <p role="alert" className="p-3 text-xs text-destructive">{state.error}</p>
    : state?.binary || /^(?:Binary files |GIT binary patch)/m.test(state?.patch ?? "") ? <p className="p-3 text-xs">{t("checkpoint.binaryHint")}</p>
    : rows.length ? <CodeBlock variant="Diff" filename={path} diff={rows} code={state?.patch} />
    : <p className="p-3 text-xs text-muted-foreground">{t("review.noChanges")}</p>}
  </div>
 </div>;
}
