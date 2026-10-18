import { useState } from "react";
import type {
  GitHubRepo,
  GitHubRun,
  GitHubWorkflow,
} from "../../../../shared/github-client";
import { api } from "../../api";
import { PlayIcon, WorkflowIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Spinner } from "../ui/spinner";
import { GitHubRef } from "./GitHubCode";
import {
  GhBack,
  GhDate,
  GhEmpty,
  GhError,
  GhExternal,
  GhLoading,
  GhMore,
  GhRefresh,
  GhStatus,
  useGitHubText,
} from "./GitHubUi";
import {
  useGitHubMutation,
  useGitHubPages,
  useGitHubResource,
} from "./useGitHub";

export function GitHubActions({ repo }: { repo: GitHubRepo }) {
  const t = useGitHubText();
  const [workflow, setWorkflow] = useState(0);
  const [status, setStatus] = useState("");
  const [branch, setBranch] = useState("");
  const [selected, setSelected] = useState<GitHubRun | null>(null);
  const [dispatch, setDispatch] = useState(false);
  const [dispatched, setDispatched] = useState(false);
  const workflows = useGitHubPages(repo.fullName, (page) =>
    api.githubClient({ action: "workflows", repo: repo.fullName, page }),
  );
  const runs = useGitHubPages(
    `${repo.fullName}:${workflow}:${status}:${branch}`,
    (page) =>
      api.githubClient({
        action: "runs",
        repo: repo.fullName,
        workflow: workflow || undefined,
        status: status || undefined,
        branch: branch || undefined,
        page,
      }),
  );
  const change = () => {
    runs.reload();
  };
  const item = runs.items.find((v) => v.id === selected?.id) || selected;
  return (
    <>
      <div className="gh-toolbar flex-wrap">
        <select
          aria-label={t("workflows")}
          className="gh-select max-w-64"
          value={workflow}
          onChange={(e) => {
            setWorkflow(Number(e.target.value));
            setSelected(null);
          }}
        >
          <option value={0}>{t("allWorkflows")}</option>
          {workflows.items.map((v) => (
            <option value={v.id} key={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <select
          aria-label={t("status")}
          className="gh-select"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setSelected(null);
          }}
        >
          <option value="">{t("all")}</option>
          {(
            [
              "queued",
              "in_progress",
              "success",
              "failure",
              "cancelled",
              "completed",
            ] as const
          ).map((value) => (
            <option value={value} key={value}>
              {t(value === "in_progress" ? "running" : value)}
            </option>
          ))}
        </select>
        <GitHubRef
          repo={repo}
          value={branch}
          allowAll
          onChange={(value) => {
            setBranch(value);
            setSelected(null);
          }}
        />
        <div className="ml-auto" />
        <GhRefresh
          onClick={() => {
            workflows.reload();
            runs.reload();
          }}
        />
        <Button
          size="sm"
          disabled={
            !repo.canPush ||
            repo.archived ||
            !workflows.items.some((w) => w.state === "active")
          }
          onClick={() => setDispatch(true)}
        >
          <PlayIcon className="size-3" />
          {t("runWorkflow")}
        </Button>
      </div>
      {dispatched && (
        <p role="status" className="px-3 py-2 text-[var(--success)]">
          {t("dispatched")}
        </p>
      )}
      <GhError error={workflows.error} retry={workflows.reload} />
      {workflows.hasNext && <GhMore {...workflows} />}
      <div className="gh-split" data-detail={selected !== null}>
        <div className="gh-list gh-scroll">
          <GhError error={runs.error} retry={runs.reload} />
          {runs.loading && !runs.items.length ? (
            <GhLoading />
          ) : !runs.items.length && !runs.error ? (
            <GhEmpty>{t("noRuns")}</GhEmpty>
          ) : null}
          {runs.items.map((run) => (
            <button
              type="button"
              className={cn(
                "gh-list-row",
                selected?.id === run.id && "is-selected",
              )}
              key={run.id}
              onClick={() => setSelected(run)}
            >
              <div className="flex gap-2">
                <WorkflowIcon className="mt-0.5 size-3.5 shrink-0" />
                <span className="line-clamp-2 font-medium">{run.title}</span>
              </div>
              <p className="my-2 text-[10px] text-muted-foreground">
                {run.workflow} #{run.number} · {run.branch}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <GhStatus value={run.conclusion || run.status} />
                <span>{run.actor}</span>
                <GhDate value={run.createdAt} />
              </div>
            </button>
          ))}
          <GhMore {...runs} />
        </div>
        <div className="gh-detail">
          {item ? (
            <RunDetail
              key={item.id}
              repo={repo}
              run={item}
              onBack={() => setSelected(null)}
              onChanged={change}
            />
          ) : (
            <GhEmpty>{t("selectRun")}</GhEmpty>
          )}
        </div>
      </div>
      {dispatch && (
        <Dispatch
          repo={repo}
          workflows={workflows.items}
          initial={workflow}
          onClose={() => setDispatch(false)}
          onDone={() => {
            setDispatch(false);
            setDispatched(true);
            runs.reload();
          }}
        />
      )}
    </>
  );
}

function RunDetail({
  repo,
  run,
  onBack,
  onChanged,
}: {
  repo: GitHubRepo;
  run: GitHubRun;
  onBack: () => void;
  onChanged: () => void;
}) {
  const t = useGitHubText();
  const mutation = useGitHubMutation();
  const jobs = useGitHubPages(`jobs:${run.id}`, (page) =>
    api.githubClient({
      action: "jobs",
      repo: repo.fullName,
      run: run.id,
      page,
    }),
  );
  const artifacts = useGitHubPages(`artifacts:${run.id}`, (page) =>
    api.githubClient({
      action: "artifacts",
      repo: repo.fullName,
      run: run.id,
      page,
    }),
  );
  const [operation, setOperation] = useState<
    "rerun" | "rerun-failed-jobs" | "cancel" | null
  >(null);
  const [log, setLog] = useState<{ id: number; name: string } | null>(null);
  const canWrite = repo.canPush && !repo.archived;
  const label =
    operation === "cancel"
      ? t("cancelRun")
      : operation === "rerun-failed-jobs"
        ? t("rerunFailed")
        : t("rerun");
  return (
    <div className="gh-scroll p-4">
      <div className="mb-3 flex gap-2">
        <GhBack onClick={onBack} />
        <GhStatus value={run.conclusion || run.status} />
        <div className="ml-auto flex">
          <GhRefresh
            onClick={() => {
              jobs.reload();
              artifacts.reload();
              onChanged();
            }}
          />
          <GhExternal url={run.url} />
        </div>
      </div>
      <h2 className="break-words text-lg font-medium">{run.title}</h2>
      <p className="my-2 text-muted-foreground">
        {run.workflow} #{run.number} · {run.branch} · {run.event}
      </p>
      <p className="mb-4 text-[10px] text-muted-foreground">
        <code>{run.sha.slice(0, 12)}</code> · {run.actor} ·{" "}
        <GhDate value={run.createdAt} />
      </p>
      <div className="mb-4 flex flex-wrap gap-2">
        {run.status === "completed" ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite || mutation.busy}
              onClick={() => {
                mutation.clear();
                setOperation("rerun");
              }}
            >
              {t("rerun")}
            </Button>
            {["failure", "timed_out", "cancelled"].includes(run.conclusion) && (
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite || mutation.busy}
                onClick={() => {
                  mutation.clear();
                  setOperation("rerun-failed-jobs");
                }}
              >
                {t("rerunFailed")}
              </Button>
            )}
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite || mutation.busy}
            onClick={() => {
              mutation.clear();
              setOperation("cancel");
            }}
          >
            {t("cancelRun")}
          </Button>
        )}
      </div>
      <GhError error={mutation.error} />
      {mutation.success && (
        <p role="status" className="mb-3 text-[var(--success)]">
          {t("done")}
        </p>
      )}
      <h3 className="mb-3 font-medium">{t("jobs")}</h3>
      <GhError error={jobs.error} retry={jobs.reload} />
      {jobs.loading && !jobs.items.length && <GhLoading />}
      {jobs.items.map((job) => (
        <details className="gh-card mb-2" key={job.id}>
          <summary className="flex cursor-pointer flex-wrap items-center gap-2">
            <GhStatus value={job.conclusion || job.status} />
            <strong className="min-w-0 flex-1 break-words font-medium">
              {job.name}
            </strong>
          </summary>
          <ol className="mt-3 space-y-2">
            {job.steps.map((step) => (
              <li
                key={step.number}
                className="flex items-center gap-2 text-[11px]"
              >
                <span className="w-5 text-muted-foreground">{step.number}</span>
                <GhStatus value={step.conclusion || step.status} />
                <span className="min-w-0 break-words">{step.name}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setLog({ id: job.id, name: job.name })}
            >
              {t("viewLog")}
            </Button>
            <GhExternal url={job.url} />
          </div>
        </details>
      ))}
      <GhMore {...jobs} />
      {log && (
        <JobLog
          key={log.id}
          repo={repo.fullName}
          job={log.id}
          name={log.name}
          onClose={() => setLog(null)}
        />
      )}
      <h3 className="mb-3 mt-5 font-medium">{t("artifacts")}</h3>
      <GhError error={artifacts.error} retry={artifacts.reload} />
      {!artifacts.loading && !artifacts.items.length && !artifacts.error && (
        <p className="text-muted-foreground">{t("noArtifacts")}</p>
      )}
      {artifacts.items.map((artifact) => (
        <div key={artifact.id} className="gh-card mb-2 flex items-center gap-2">
          <strong className="min-w-0 flex-1 truncate font-medium">
            {artifact.name}
          </strong>
          <span className="text-[10px] text-muted-foreground">
            {(artifact.size / 1024).toFixed(1)} KB
          </span>
          {artifact.expired ? (
            <span className="gh-badge">{t("expired")}</span>
          ) : (
            <GhExternal url={artifact.url} />
          )}
        </div>
      ))}
      <GhMore {...artifacts} />
      <ConfirmDialog
        open={operation !== null}
        onOpenChange={(value) => {
          if (!value && !mutation.busy) setOperation(null);
        }}
        title={label}
        description={`${repo.fullName} · ${run.workflow} #${run.number}`}
        footer={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={mutation.busy}
              onClick={() => setOperation(null)}
            >
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              disabled={mutation.busy}
              onClick={() =>
                void mutation.run(async () => {
                  if (!operation) return;
                  await api.githubClient({
                    action: "runAction",
                    repo: repo.fullName,
                    run: run.id,
                    operation,
                  });
                  setOperation(null);
                  jobs.reload();
                  onChanged();
                })
              }
            >
              {mutation.busy && <Spinner className="size-3" />}
              {label}
            </Button>
          </>
        }
      >
        <p className="break-words">{run.title}</p>
        <GhError error={mutation.error} />
      </ConfirmDialog>
    </div>
  );
}

function JobLog({
  repo,
  job,
  name,
  onClose,
}: {
  repo: string;
  job: number;
  name: string;
  onClose: () => void;
}) {
  const t = useGitHubText();
  const log = useGitHubResource(String(job), () =>
    api.githubClient({ action: "jobLog", repo, job }),
  );
  return (
    <section className="gh-card my-3">
      <div className="mb-3 flex items-center gap-2">
        <strong className="min-w-0 flex-1 break-words">
          {t("log")} · {name}
        </strong>
        <Button variant="ghost" size="xs" onClick={onClose}>
          {t("cancel")}
        </Button>
        <GhRefresh onClick={log.reload} />
      </div>
      <GhError error={log.error} retry={log.reload} />
      {log.loading ? (
        <GhLoading />
      ) : (
        log.data && (
          <>
            {log.data.truncated && (
              <p className="mb-2 text-muted-foreground">{t("logTruncated")}</p>
            )}
            <pre className="gh-code max-h-96 overflow-auto">
              {log.data.text || t("noLogs")}
            </pre>
          </>
        )
      )}
    </section>
  );
}

function Dispatch({
  repo,
  workflows,
  initial,
  onClose,
  onDone,
}: {
  repo: GitHubRepo;
  workflows: GitHubWorkflow[];
  initial: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useGitHubText();
  const mutation = useGitHubMutation();
  const active = workflows.filter((w) => w.state === "active");
  const [workflow, setWorkflow] = useState(
    active.some((w) => w.id === initial) ? initial : active[0]?.id || 0,
  );
  const [ref, setRef] = useState(repo.defaultBranch);
  const [json, setJson] = useState("{}");
  const submit = () =>
    mutation.run(async () => {
      let inputs: unknown;
      try {
        inputs = JSON.parse(json);
      } catch {
        throw new Error(t("inputsInvalid"));
      }
      if (
        !inputs ||
        typeof inputs !== "object" ||
        Array.isArray(inputs) ||
        Object.values(inputs).some((v) => typeof v !== "string")
      )
        throw new Error(t("inputsInvalid"));
      await api.githubClient({
        action: "dispatch",
        repo: repo.fullName,
        workflow,
        ref,
        inputs: inputs as Record<string, string>,
      });
      onDone();
    });
  return (
    <ConfirmDialog
      open
      onOpenChange={(value) => {
        if (!value && !mutation.busy) onClose();
      }}
      title={t("runWorkflow")}
      description={repo.fullName}
      wide
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={mutation.busy}
            onClick={onClose}
          >
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            disabled={mutation.busy || !workflow || !ref.trim()}
            onClick={() => void submit()}
          >
            {mutation.busy && <Spinner className="size-3" />}
            {t("dispatch")}
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground">{t("dispatchHint")}</p>
      <label className="gh-label">
        {t("workflow")}
        <select
          className="gh-select"
          value={workflow}
          onChange={(e) => setWorkflow(Number(e.target.value))}
        >
          {workflows
            .filter((w) => w.state === "active")
            .map((w) => (
              <option value={w.id} key={w.id}>
                {w.name}
              </option>
            ))}
        </select>
      </label>
      <label className="gh-label">
        {t("branch")}
        <Input value={ref} onChange={(e) => setRef(e.target.value)} />
      </label>
      <label className="gh-label">
        {t("workflowInputs")}
        <Textarea
          className="font-mono"
          rows={5}
          value={json}
          onChange={(e) => setJson(e.target.value)}
        />
      </label>
      <GhError error={mutation.error} />
    </ConfirmDialog>
  );
}
