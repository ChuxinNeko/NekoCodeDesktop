import { useState } from "react";
import type { GitHubRepo } from "../../../../shared/github-client";
import { api } from "../../api";
import {
  FileIcon,
  FolderIcon,
  GitCommitIcon,
  PencilIcon,
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
  useGitHubText,
} from "./GitHubUi";
import {
  useGitHubMutation,
  useGitHubPages,
  useGitHubResource,
} from "./useGitHub";

export function GitHubRef({
  repo,
  value,
  onChange,
  disabled,
  allowAll,
}: {
  repo: GitHubRepo;
  value: string;
  onChange: (ref: string) => void;
  disabled?: boolean;
  allowAll?: boolean;
}) {
  const t = useGitHubText();
  const branches = useGitHubResource(repo.fullName, () =>
    api.githubClient({ action: "branches", repo: repo.fullName }),
  );
  return (
    <label className="flex min-w-0 items-center gap-2 text-muted-foreground">
      <span className="shrink-0">{t("branch")}</span>
      <select
        className="gh-select max-w-64"
        aria-label={t("branch")}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {allowAll && <option value="">{t("all")}</option>}
        {value && !branches.data?.includes(value) && (
          <option value={value}>{value}</option>
        )}
        {branches.data?.map((branch) => (
          <option key={branch} value={branch}>
            {branch}
          </option>
        ))}
      </select>
      {branches.error && <span title={branches.error}>!</span>}
    </label>
  );
}

export function GitHubCode({ repo }: { repo: GitHubRepo }) {
  const t = useGitHubText();
  const mutation = useGitHubMutation();
  const [ref, setRef] = useState(repo.defaultBranch);
  const [path, setPath] = useState("");
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState("");
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState(false);
  const contents = useGitHubResource(`${ref}:${path}`, () =>
    api.githubClient({ action: "contents", repo: repo.fullName, path, ref }),
  );
  const file = contents.data?.file;
  const navigate = (next: string) => {
    setPath(next);
    mutation.clear();
  };
  const parts = path.split("/").filter(Boolean);
  return (
    <>
      <div className="gh-toolbar">
        <GitHubRef
          repo={repo}
          value={ref}
          disabled={editing}
          onChange={(value) => {
            setRef(value);
            setEditing(false);
            mutation.clear();
          }}
        />
        <div className="ml-auto" />
        <GhRefresh
          onClick={contents.reload}
          disabled={editing || contents.loading}
        />
        {file && <GhExternal url={file.url} />}
      </div>
      <div className="gh-breadcrumbs">
        <button type="button" disabled={editing} onClick={() => navigate("")}>
          {t("root")}
        </button>
        {parts.map((part, i) => (
          <span key={i}>
            {" "}
            /{" "}
            <button
              type="button"
              disabled={editing}
              onClick={() => navigate(parts.slice(0, i + 1).join("/"))}
            >
              {part}
            </button>
          </span>
        ))}
      </div>
      <GhError error={contents.error} retry={contents.reload} />
      {mutation.success && (
        <p role="status" className="px-4 py-2 text-[var(--success)]">
          {t("changesSaved")}
        </p>
      )}
      <div className="gh-scroll">
        {contents.loading ? (
          <GhLoading />
        ) : file ? (
          <>
            <div className="gh-toolbar">
              <FileIcon className="size-4" />
              <strong className="min-w-0 flex-1 truncate">{file.name}</strong>
              <span className="text-[10px] text-muted-foreground">
                {file.size.toLocaleString()} B
              </span>
              {file.editable && repo.canPush && !repo.archived && !editing && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditor(file.text);
                    setMessage(`Update ${file.path}`);
                    setEditing(true);
                    mutation.clear();
                  }}
                >
                  <PencilIcon className="size-3" />
                  {t("editFile")}
                </Button>
              )}
            </div>
            {!file.editable ? (
              <GhEmpty>{file.notice}</GhEmpty>
            ) : editing ? (
              <div className="flex flex-col gap-3 p-4">
                <Textarea
                  aria-label={file.path}
                  className="min-h-80 font-mono text-xs"
                  value={editor}
                  onChange={(e) => setEditor(e.target.value)}
                  disabled={mutation.busy}
                />
                <label className="gh-label">
                  {t("commitMessage")}
                  <Input
                    maxLength={4096}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={mutation.busy}
                  />
                </label>
                <GhError error={mutation.error} />
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={mutation.busy}
                    onClick={() => setEditing(false)}
                  >
                    {t("cancel")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      mutation.busy || !message.trim() || editor === file.text
                    }
                    onClick={() => setConfirm(true)}
                  >
                    {t("commitChanges")}
                  </Button>
                </div>
              </div>
            ) : /(^|\/)readme(?:\.[^.]+)?$/i.test(file.path) &&
              /\.(md|markdown)$/i.test(file.path) ? (
              <div className="p-5">
                <GhMarkdown text={file.text} />
              </div>
            ) : (
              <pre className="gh-code p-4">{file.text}</pre>
            )}
          </>
        ) : (
          <div className="gh-directory">
            {path && (
              <button
                type="button"
                className="gh-directory-row"
                onClick={() => navigate(parts.slice(0, -1).join("/"))}
              >
                <FolderIcon className="size-4" />
                .. <span className="text-muted-foreground">{t("parent")}</span>
              </button>
            )}
            {contents.data?.entries
              .slice()
              .sort(
                (a, b) =>
                  (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) ||
                  a.name.localeCompare(b.name),
              )
              .map((item) => (
                <button
                  type="button"
                  key={item.path}
                  className="gh-directory-row"
                  onClick={() => navigate(item.path)}
                >
                  {item.type === "dir" ? (
                    <FolderIcon className="size-4 text-muted-foreground" />
                  ) : (
                    <FileIcon className="size-4 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate">{item.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {item.type === "dir"
                      ? ""
                      : `${item.size.toLocaleString()} B`}
                  </span>
                </button>
              ))}
            {!contents.error && !contents.data?.entries.length && (
              <GhEmpty>{t("emptyDirectory")}</GhEmpty>
            )}
          </div>
        )}
      </div>
      {file && (
        <ConfirmDialog
          open={confirm}
          onOpenChange={(value) => {
            if (!mutation.busy) setConfirm(value);
          }}
          title={t("commitChanges")}
          description={`${repo.fullName} · ${ref} · ${file.path}`}
          footer={
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.busy}
                onClick={() => setConfirm(false)}
              >
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                disabled={mutation.busy}
                onClick={() =>
                  void mutation.run(async () => {
                    await api.githubClient({
                      action: "saveFile",
                      repo: repo.fullName,
                      path: file.path,
                      branch: ref,
                      sha: file.sha,
                      text: editor,
                      message,
                    });
                    setConfirm(false);
                    setEditing(false);
                    contents.reload();
                  })
                }
              >
                {mutation.busy && <Spinner className="size-3" />}
                {t("commitChanges")}
              </Button>
            </>
          }
        >
          <p>{t("commitHint")}</p>
          <p className="break-words font-medium">{message}</p>
          <GhError error={mutation.error} />
        </ConfirmDialog>
      )}
    </>
  );
}

export function GitHubCommits({ repo }: { repo: GitHubRepo }) {
  const t = useGitHubText();
  const [ref, setRef] = useState(repo.defaultBranch);
  const [sha, setSha] = useState<string | null>(null);
  const commits = useGitHubPages(`${repo.fullName}:${ref}`, (page) =>
    api.githubClient({ action: "commits", repo: repo.fullName, ref, page }),
  );
  return (
    <>
      <div className="gh-toolbar">
        <GitHubRef
          repo={repo}
          value={ref}
          onChange={(value) => {
            setRef(value);
            setSha(null);
          }}
        />
        <div className="ml-auto" />
        <GhRefresh onClick={commits.reload} disabled={commits.loading} />
      </div>
      <div className="gh-split" data-detail={sha !== null}>
        <div className="gh-list gh-scroll">
          <GhError error={commits.error} retry={commits.reload} />
          {commits.loading && !commits.items.length ? (
            <GhLoading />
          ) : !commits.items.length && !commits.error ? (
            <GhEmpty>{t("noCommits")}</GhEmpty>
          ) : null}
          {commits.items.map((item) => (
            <button
              type="button"
              className={cn("gh-list-row", sha === item.sha && "is-selected")}
              key={item.sha}
              onClick={() => setSha(item.sha)}
            >
              <div className="flex gap-2">
                <GitCommitIcon className="mt-0.5 size-3.5 shrink-0" />
                <span className="line-clamp-2 font-medium">
                  {item.message.split("\n")[0]}
                </span>
              </div>
              <p className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                <code>{item.sha.slice(0, 7)}</code>
                <span>{item.author}</span>
                <GhDate value={item.date} />
              </p>
            </button>
          ))}
          <GhMore {...commits} />
        </div>
        <div className="gh-detail">
          {sha ? (
            <CommitDetail
              key={sha}
              repo={repo.fullName}
              sha={sha}
              onBack={() => setSha(null)}
            />
          ) : (
            <GhEmpty>{t("selectCommit")}</GhEmpty>
          )}
        </div>
      </div>
    </>
  );
}

function CommitDetail({
  repo,
  sha,
  onBack,
}: {
  repo: string;
  sha: string;
  onBack: () => void;
}) {
  const t = useGitHubText();
  const detail = useGitHubResource(sha, () =>
    api.githubClient({ action: "commit", repo, sha }),
  );
  const files = useGitHubPages(
    sha,
    async (page) =>
      (await api.githubClient({ action: "commit", repo, sha, page })).files,
  );
  return (
    <div className="gh-scroll p-4">
      <div className="mb-3 flex gap-2">
        <GhBack onClick={onBack} />
        <div className="ml-auto">
          <GhExternal url={detail.data?.url || ""} />
        </div>
      </div>
      <GhError error={detail.error} retry={detail.reload} />
      {detail.loading ? (
        <GhLoading />
      ) : (
        detail.data && (
          <>
            <h2 className="break-words text-base font-medium">
              {detail.data.message.split("\n")[0]}
            </h2>
            {detail.data.message.includes("\n") && (
              <p className="mt-3 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted-foreground">
                {detail.data.message.split("\n").slice(1).join("\n").trim()}
              </p>
            )}
            <p className="my-3 break-all font-mono text-[10px] text-muted-foreground">
              {sha}
            </p>
            <p className="mb-4 text-muted-foreground">
              {detail.data.author} · <GhDate value={detail.data.date} />
            </p>
            <GhError error={files.error} retry={files.reload} />
            <GhFiles files={files.items} />
            <GhMore {...files} />
          </>
        )
      )}
    </div>
  );
}
