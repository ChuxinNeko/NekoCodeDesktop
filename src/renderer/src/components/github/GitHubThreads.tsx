import { useState } from "react";
import type {
  GitHubComment,
  GitHubPull,
  GitHubRepo,
} from "../../../../shared/github-client";
import { api } from "../../api";
import {
  CircleDotIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  PlusIcon,
  SearchIcon,
} from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Spinner } from "../ui/spinner";
import {
  GhBack,
  GhDate,
  GhEmpty,
  GhError,
  GhExternal,
  GhFiles,
  GhLoading,
  GhMarkdown,
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

export function GitHubThreads({
  repo,
  kind,
}: {
  repo: GitHubRepo;
  kind: "issues" | "pulls";
}) {
  const t = useGitHubText();
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const results = useGitHubPages(
    `${repo.fullName}:${kind}:${state}:${query}`,
    (page) =>
      api.githubClient({
        action: kind,
        repo: repo.fullName,
        state,
        query,
        page,
      }),
  );
  const Icon = kind === "pulls" ? GitPullRequestIcon : CircleDotIcon;
  return (
    <>
      <div className="gh-toolbar">
        <select
          aria-label={t("filter")}
          className="gh-select"
          value={state}
          onChange={(e) => {
            setState(e.target.value as typeof state);
            setSelected(null);
          }}
        >
          {(["open", "closed", "all"] as const).map((v) => (
            <option value={v} key={v}>
              {t(v)}
            </option>
          ))}
        </select>
        <form
          className="flex min-w-24 flex-1 gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search.trim());
            setSelected(null);
          }}
        >
          <Input
            aria-label={t("searchThreads")}
            placeholder={t("searchThreads")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button
            variant="ghost"
            size="icon"
            type="submit"
            aria-label={t("search")}
          >
            <SearchIcon className="size-3.5" />
          </Button>
        </form>
        <GhRefresh onClick={results.reload} disabled={results.loading} />
        <Button
          size="sm"
          disabled={repo.archived}
          onClick={() => setCreating(true)}
        >
          <PlusIcon className="size-3.5" />
          {kind === "issues" ? t("newIssue") : t("newPull")}
        </Button>
      </div>
      <div className="gh-split" data-detail={selected !== null}>
        <div className="gh-list gh-scroll">
          <GhError error={results.error} retry={results.reload} />
          {results.loading && !results.items.length ? (
            <GhLoading />
          ) : !results.items.length && !results.error ? (
            <GhEmpty>{t("noThreads")}</GhEmpty>
          ) : null}
          {results.items.map((item) => (
            <button
              className={cn(
                "gh-list-row",
                selected === item.number && "is-selected",
              )}
              key={item.number}
              type="button"
              onClick={() => setSelected(item.number)}
            >
              <div className="flex gap-2">
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <strong className="min-w-0 break-words font-medium">
                  {item.title}
                </strong>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <span>#{item.number}</span>
                <span>{item.author}</span>
                <GhDate value={item.updatedAt} />
                <GhStatus value={item.draft ? "draft" : item.state} />
              </div>
              {item.labels.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {item.labels.map((label) => (
                    <span key={label} className="gh-badge">
                      {label}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
          <GhMore {...results} />
        </div>
        <div className="gh-detail">
          {selected === null ? (
            <GhEmpty>{t("selectThread")}</GhEmpty>
          ) : (
            <ThreadDetail
              key={`${kind}:${selected}`}
              repo={repo}
              kind={kind}
              number={selected}
              onBack={() => setSelected(null)}
              onChanged={results.reload}
            />
          )}
        </div>
      </div>
      {creating && (
        <CreateThread
          repo={repo}
          kind={kind}
          onClose={() => setCreating(false)}
          onCreated={(number) => {
            setCreating(false);
            setState("open");
            setQuery("");
            setSearch("");
            setSelected(number);
            results.reload();
          }}
        />
      )}
    </>
  );
}

function CreateThread({
  repo,
  kind,
  onClose,
  onCreated,
}: {
  repo: GitHubRepo;
  kind: "issues" | "pulls";
  onClose: () => void;
  onCreated: (number: number) => void;
}) {
  const t = useGitHubText();
  const mutation = useGitHubMutation();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [head, setHead] = useState("");
  const [base, setBase] = useState(repo.defaultBranch);
  const [draft, setDraft] = useState(false);
  const submit = () =>
    mutation.run(async () => {
      const result =
        kind === "issues"
          ? await api.githubClient({
              action: "issueCreate",
              repo: repo.fullName,
              title,
              body,
            })
          : await api.githubClient({
              action: "pullCreate",
              repo: repo.fullName,
              title,
              body,
              head,
              base,
              draft,
            });
      onCreated(result.number);
    });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.busy) onClose();
      }}
      title={kind === "issues" ? t("newIssue") : t("newPull")}
      description={repo.fullName}
      wide
      footer={
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={mutation.busy}
            onClick={onClose}
          >
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            disabled={
              mutation.busy ||
              !title.trim() ||
              (kind === "pulls" &&
                (!head.trim() || !base.trim() || head === base))
            }
            onClick={() => void submit()}
          >
            {mutation.busy && <Spinner className="size-3" />}
            {t("create")}
          </Button>
        </>
      }
    >
      <label className="gh-label">
        {t("title")}
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={256}
        />
      </label>
      <label className="gh-label">
        {t("body")}
        <Textarea
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      {kind === "pulls" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <label className="gh-label">
              {t("head")}
              <Input
                value={head}
                onChange={(e) => setHead(e.target.value)}
                placeholder="feature-branch"
              />
            </label>
            <label className="gh-label">
              {t("base")}
              <Input value={base} onChange={(e) => setBase(e.target.value)} />
            </label>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
            />
            {t("draft")}
          </label>
        </>
      )}
      <GhError error={mutation.error} />
    </ConfirmDialog>
  );
}

function ThreadDetail({
  repo,
  kind,
  number,
  onBack,
  onChanged,
}: {
  repo: GitHubRepo;
  kind: "issues" | "pulls";
  number: number;
  onBack: () => void;
  onChanged: () => void;
}) {
  const t = useGitHubText();
  const mutation = useGitHubMutation();
  const detail = useGitHubResource(`${kind}:${number}`, () =>
    kind === "issues"
      ? api.githubClient({ action: "issue", repo: repo.fullName, number })
      : api.githubClient({ action: "pull", repo: repo.fullName, number }),
  );
  const discussion = useGitHubPages(`comments:${number}`, (page) =>
    api.githubClient({ action: "comments", repo: repo.fullName, number, page }),
  );
  const [body, setBody] = useState("");
  const [posted, setPosted] = useState<GitHubComment[]>([]);
  const [merging, setMerging] = useState(false);
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">(
    repo.mergeMethods[0] ?? "merge",
  );
  if (detail.loading)
    return (
      <>
        <GhBack onClick={onBack} />
        <GhLoading />
      </>
    );
  if (detail.error || !detail.data)
    return (
      <>
        <GhBack onClick={onBack} />
        <GhError error={detail.error} retry={detail.reload} />
      </>
    );
  const item = detail.data;
  const pull = "headSha" in item ? (item as GitHubPull) : null;
  const canWrite = repo.canPush && !repo.archived;
  const comments = [
    ...discussion.items,
    ...posted.filter((c) => !discussion.items.some((v) => v.id === c.id)),
  ];
  return (
    <div className="gh-scroll p-4">
      <div className="mb-3 flex items-center gap-2">
        <GhBack onClick={onBack} />
        <GhStatus
          value={pull?.merged ? "merged" : item.draft ? "draft" : item.state}
        />
        <span className="text-muted-foreground">#{number}</span>
        <div className="ml-auto flex">
          <GhRefresh
            onClick={() => {
              detail.reload();
              discussion.reload();
            }}
          />
          <GhExternal url={item.url} />
        </div>
      </div>
      <h2 className="break-words text-lg font-medium">{item.title}</h2>
      <p className="my-2 text-[11px] text-muted-foreground">
        {item.author} · <GhDate value={item.createdAt} />
        {pull && (
          <>
            {" "}
            ·{" "}
            <span className="font-mono">
              {pull.head} → {pull.base}
            </span>
          </>
        )}
      </p>
      <div className="my-3 flex flex-wrap gap-1">
        {item.labels.map((label) => (
          <span className="gh-badge" key={label}>
            {label}
          </span>
        ))}
      </div>
      <div className="gh-card">
        <GhMarkdown text={item.body || t("noDescription")} />
      </div>
      {pull && <PullExtras repo={repo.fullName} pull={pull} />}
      {pull && !pull.merged && pull.state === "open" && (
        <div className="gh-card my-4">
          <div className="flex flex-wrap items-center gap-2">
            <GitMergeIcon className="size-4" />
            <strong>{t("merge")}</strong>
            <Button
              className="ml-auto"
              size="sm"
              disabled={
                !canWrite ||
                pull.draft ||
                pull.mergeable !== true ||
                mutation.busy ||
                !repo.mergeMethods.length
              }
              onClick={() => {
                mutation.clear();
                setMerging(true);
              }}
            >
              {t("merge")}
            </Button>
          </div>
          {!canWrite && (
            <p className="mt-2 text-muted-foreground">{t("writeDenied")}</p>
          )}
          {pull.mergeable === false && (
            <p className="mt-2 text-destructive">{t("conflict")}</p>
          )}
          {pull.mergeable === null && (
            <p className="mt-2 text-muted-foreground">{t("mergePending")}</p>
          )}
        </div>
      )}
      <h3 className="mb-3 mt-5 font-medium">
        {t("discussion")}{" "}
        <span className="text-muted-foreground">{item.comments}</span>
      </h3>
      <GhError error={discussion.error} retry={discussion.reload} />
      <div className="flex flex-col gap-3">
        {comments.map((c) => (
          <div className="gh-card" key={c.id}>
            <div className="mb-2 flex items-center gap-2 text-[11px]">
              <strong>{c.author}</strong>
              <span className="text-muted-foreground">
                <GhDate value={c.createdAt} />
              </span>
              <span className="ml-auto">
                <GhExternal url={c.url} />
              </span>
            </div>
            <GhMarkdown text={c.body} />
          </div>
        ))}
      </div>
      <GhMore {...discussion} />
      {discussion.loading && !comments.length && <GhLoading />}
      <form
        className="mt-4 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void mutation.run(async () => {
            const result = await api.githubClient({
              action: "comment",
              repo: repo.fullName,
              number,
              body,
            });
            setPosted((p) => [...p, result]);
            setBody("");
            onChanged();
            detail.reload();
          });
        }}
      >
        <label className="gh-label">
          {t("reply")}
          <Textarea
            rows={4}
            maxLength={65536}
            placeholder={t("replyPlaceholder")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={repo.archived || mutation.busy}
          />
        </label>
        <GhError error={mutation.error} />
        {mutation.success && (
          <p role="status" className="text-[var(--success)]">
            {t("done")}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {kind === "issues" && canWrite && (
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={mutation.busy}
              onClick={() =>
                void mutation.run(async () => {
                  await api.githubClient({
                    action: "issueState",
                    repo: repo.fullName,
                    number,
                    state: item.state === "open" ? "closed" : "open",
                  });
                  detail.reload();
                  onChanged();
                })
              }
            >
              {item.state === "open" ? t("closeIssue") : t("reopenIssue")}
            </Button>
          )}
          <Button
            size="sm"
            type="submit"
            disabled={!body.trim() || mutation.busy || repo.archived}
          >
            {mutation.busy && <Spinner className="size-3" />}
            {t("sendReply")}
          </Button>
        </div>
      </form>
      {pull && (
        <ConfirmDialog
          open={merging}
          onOpenChange={(value) => {
            if (!mutation.busy) setMerging(value);
          }}
          title={t("confirmMerge")}
          description={`${repo.fullName} #${number} · ${pull.head} → ${pull.base}`}
          footer={
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={mutation.busy}
                onClick={() => setMerging(false)}
              >
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                disabled={mutation.busy}
                onClick={() =>
                  void mutation.run(async () => {
                    await api.githubClient({
                      action: "merge",
                      repo: repo.fullName,
                      number,
                      sha: pull.headSha,
                      method,
                    });
                    setMerging(false);
                    detail.reload();
                    onChanged();
                  })
                }
              >
                {mutation.busy && <Spinner className="size-3" />}
                {t("confirmMerge")}
              </Button>
            </>
          }
        >
          <p>{t("mergeHint")}</p>
          <p className="break-all font-mono text-[10px] text-muted-foreground">
            {pull.headSha}
          </p>
          <label className="gh-label">
            {t("mergeMethod")}
            <select
              className="gh-select"
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
            >
              {repo.mergeMethods.map((v) => (
                <option key={v} value={v}>
                  {v === "merge"
                    ? t("mergeCommit")
                    : v === "squash"
                      ? t("squash")
                      : t("rebase")}
                </option>
              ))}
            </select>
          </label>
          <GhError error={mutation.error} />
        </ConfirmDialog>
      )}
    </div>
  );
}

function PullExtras({ repo, pull }: { repo: string; pull: GitHubPull }) {
  const t = useGitHubText();
  const files = useGitHubPages(`files:${pull.number}:${pull.headSha}`, (page) =>
    api.githubClient({ action: "pullFiles", repo, number: pull.number, page }),
  );
  const checks = useGitHubResource(`checks:${pull.headSha}`, () =>
    api.githubClient({ action: "checks", repo, sha: pull.headSha }),
  );
  const reviews = useGitHubPages(`reviews:${pull.number}`, (page) =>
    api.githubClient({ action: "reviews", repo, number: pull.number, page }),
  );
  return (
    <>
      <details className="gh-section" open>
        <summary>
          {t("checks")}{" "}
          <span className="text-muted-foreground">
            {checks.data?.length ?? 0}
          </span>
        </summary>
        <GhError error={checks.error} retry={checks.reload} />
        {checks.loading ? (
          <GhLoading />
        ) : checks.data?.length ? (
          checks.data.map((check, i) => (
            <div className="flex items-center gap-2 py-1" key={i}>
              <GhStatus value={check.conclusion || check.status} />
              <span className="min-w-0 flex-1 truncate">{check.name}</span>
              <GhExternal url={check.url} />
            </div>
          ))
        ) : (
          <p className="text-muted-foreground">{t("noChecks")}</p>
        )}
      </details>
      <details className="gh-section">
        <summary>
          {t("files")}{" "}
          <span className="text-muted-foreground">
            {pull.changedFiles} · +{pull.additions} −{pull.deletions}
          </span>
        </summary>
        <GhError error={files.error} retry={files.reload} />
        <GhFiles files={files.items} />
        <GhMore {...files} />
      </details>
      {(reviews.items.length > 0 || reviews.error) && (
        <details className="gh-section">
          <summary>{t("reviewComments")}</summary>
          <GhError error={reviews.error} retry={reviews.reload} />
          {reviews.items.map((c) => (
            <div key={c.id} className="gh-card my-2">
              <p className="mb-2 text-[11px] text-muted-foreground">
                {c.author} · {c.path}
              </p>
              <GhMarkdown text={c.body} />
            </div>
          ))}
          <GhMore {...reviews} />
        </details>
      )}
    </>
  );
}
