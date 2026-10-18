import { useEffect, useRef, useState } from "react";
import type { GitHubRepo } from "../../../../shared/github-client";
import { api } from "../../api";
import {
  GitHubIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  CircleDotIcon,
  FolderIcon,
  WorkflowIcon,
  SearchIcon,
  SettingsIcon,
  XIcon,
  StarIcon,
} from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useGitHubPages, useGitHubResource } from "./useGitHub";
import {
  GhDate,
  GhEmpty,
  GhError,
  GhExternal,
  GhLoading,
  GhMore,
  GhRefresh,
  useGitHubText,
} from "./GitHubUi";
import { GitHubThreads } from "./GitHubThreads";
import { GitHubCode, GitHubCommits } from "./GitHubCode";
import { GitHubActions } from "./GitHubActions";
import "./github.css";

type Tab = "overview" | "issues" | "pulls" | "code" | "commits" | "actions";
const TABS = [
  { id: "overview", Icon: GitHubIcon },
  { id: "issues", Icon: CircleDotIcon },
  { id: "pulls", Icon: GitPullRequestIcon },
  { id: "code", Icon: FolderIcon },
  { id: "commits", Icon: GitCommitIcon },
  { id: "actions", Icon: WorkflowIcon },
] as const;
const STORAGE = "nekocode:github-repository";
function savedRepo() {
  try {
    return localStorage.getItem(STORAGE) || "";
  } catch {
    return "";
  }
}

export function GitHubPage({
  cwd,
  onClose,
  onOpenSettings,
}: {
  cwd: string | null;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const t = useGitHubText();
  const [repo, setRepo] = useState(savedRepo);
  const [reposOpen, setReposOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const manuallySelected = useRef(false);
  const connection = useGitHubResource("github-connection", async () => {
    const status = await api.githubStatus();
    if (!status.configured)
      return { status, login: "", avatar: null as string | null };
    const profile = await api.githubProfile();
    return {
      status,
      login: profile.account.login,
      avatar: profile.account.avatarUrl,
    };
  });
  const chooseRepo = (name: string) => {
    manuallySelected.current = true;
    setRepo(name);
    setReposOpen(false);
    try {
      localStorage.setItem(STORAGE, name);
    } catch {
      /* storage can be disabled */
    }
  };
  useEffect(() => {
    if (!cwd || !connection.data?.status.configured || savedRepo()) return;
    let active = true;
    void api
      .githubClient({ action: "workspaceRepository", cwd })
      .then((name) => {
        if (active && name && !manuallySelected.current) {
          setRepo(name);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [cwd, connection.data?.status.configured]);
  return (
    <section className="gh-workbench" aria-label="GitHub">
      <header className="gh-header">
        <GitHubIcon className="size-5" />
        <strong className="text-sm">GitHub</strong>
        <Button
          variant="ghost"
          size="xs"
          className="gh-repo-toggle"
          onClick={() => setReposOpen((v) => !v)}
        >
          <FolderIcon className="size-3.5" />
          {repo || t("repositories")}
        </Button>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {connection.data?.login && (
            <span className="gh-account">
              {connection.data.avatar && (
                <img
                  src={connection.data.avatar}
                  alt=""
                  className="size-5 rounded-full"
                />
              )}
              <span className="truncate">{connection.data.login}</span>
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("settings")}
            onClick={onOpenSettings}
          >
            <SettingsIcon className="size-3.5" />
          </Button>
          <GhRefresh
            onClick={() => {
              connection.reload();
              setRevision((v) => v + 1);
            }}
            disabled={connection.loading}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("close")}
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </header>
      <GhError error={connection.error} retry={connection.reload} />
      {connection.loading && !connection.data ? (
        <GhLoading />
      ) : connection.data?.status.configured ? (
        <div className="gh-body" data-repos-open={reposOpen || !repo}>
          <Repositories key={revision} selected={repo} onSelect={chooseRepo} />
          <div className="gh-content">
            <RepositoryWorkspace key={`${repo}:${revision}`} name={repo} />
          </div>
        </div>
      ) : (
        <GhEmpty>
          <GitHubIcon className="mx-auto mb-4 size-10 opacity-60" />
          <h2>{t("connect")}</h2>
          <p className="mt-2 max-w-sm">
            {connection.data?.status.warning || t("authHint")}
          </p>
          <Button className="mt-5" onClick={onOpenSettings}>
            {t("settings")}
          </Button>
        </GhEmpty>
      )}
    </section>
  );
}

function Repositories({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (name: string) => void;
}) {
  const t = useGitHubText();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const repos = useGitHubPages(query, (page) =>
    api.githubClient({ action: "repositories", query, page }),
  );
  return (
    <aside className="gh-repositories" aria-label={t("repositories")}>
      <div className="flex items-center justify-between px-3 pt-3">
        <h2 className="font-medium">{t("repositories")}</h2>
        <span className="text-muted-foreground">
          {repos.items.length}
          {repos.hasNext ? "+" : ""}
        </span>
      </div>
      <form
        className="flex gap-1 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(search.trim());
        }}
      >
        <Input
          aria-label={t("repoQuery")}
          value={search}
          placeholder={t("repositorySearch")}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          aria-label={t("search")}
        >
          <SearchIcon className="size-3.5" />
        </Button>
      </form>
      {/^[\w.-]+\/[\w.-]+$/.test(search.trim()) && (
        <Button
          className="mx-2 mb-2"
          variant="outline"
          size="sm"
          onClick={() => onSelect(search.trim())}
        >
          {t("openRepo")}
        </Button>
      )}
      <GhError error={repos.error} retry={repos.reload} />
      <div className="gh-scroll px-2 pb-2">
        {repos.loading && !repos.items.length ? (
          <GhLoading />
        ) : !repos.items.length && !repos.error ? (
          <GhEmpty>{t("noRepos")}</GhEmpty>
        ) : null}
        {repos.items.map((item) => (
          <button
            type="button"
            key={item.fullName}
            className={cn(
              "gh-repo-row",
              selected === item.fullName && "is-selected",
            )}
            onClick={() => onSelect(item.fullName)}
          >
            <div className="flex items-center gap-2">
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="truncate font-medium">
                {item.fullName.split("/").at(-1)}
              </span>
              <span className="ml-auto text-[9px] text-muted-foreground">
                {item.private ? t("private") : ""}
              </span>
            </div>
            <div className="mt-1 truncate pl-5 text-[10px] text-muted-foreground">
              {item.fullName}
            </div>
            {item.description && (
              <p className="mt-1 line-clamp-2 pl-5 text-[10px] text-muted-foreground">
                {item.description}
              </p>
            )}
          </button>
        ))}
        <GhMore {...repos} />
      </div>
    </aside>
  );
}

function RepositoryWorkspace({ name }: { name: string }) {
  const t = useGitHubText();
  const [tab, setTab] = useState<Tab>("overview");
  const repo = useGitHubResource(name, () =>
    name
      ? api.githubClient({ action: "repository", repo: name })
      : Promise.resolve(null),
  );
  if (!name)
    return (
      <GhEmpty>
        <GitHubIcon className="mx-auto mb-3 size-8 opacity-40" />
        {t("chooseRepo")}
        <p className="mt-2 text-[11px]">{t("manualRepoHint")}</p>
      </GhEmpty>
    );
  if (repo.loading) return <GhLoading />;
  if (repo.error) return <GhError error={repo.error} retry={repo.reload} />;
  if (!repo.data) return null;
  const data = repo.data;
  return (
    <>
      <div className="gh-repo-heading">
        <div className="flex min-w-0 items-center gap-2">
          <GitHubIcon className="size-4 shrink-0" />
          <h1
            className="min-w-0 truncate text-[14px] font-semibold"
            title={name}
          >
            {name}
          </h1>
          <span className="gh-badge">
            {data.private ? t("private") : t("public")}
          </span>
          {data.archived && <span className="gh-badge">{t("archived")}</span>}
          <GhExternal url={data.url} />
        </div>
        <nav className="gh-tabs" aria-label={name}>
          {TABS.map(({ id, Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              <Icon className="size-3.5" />
              {t(id)}
            </button>
          ))}
        </nav>
      </div>
      <div className="gh-panel" key={tab}>
        {tab === "overview" ? (
          <Overview repo={data} onTab={setTab} />
        ) : tab === "issues" || tab === "pulls" ? (
          <GitHubThreads repo={data} kind={tab} />
        ) : tab === "code" ? (
          <GitHubCode repo={data} />
        ) : tab === "commits" ? (
          <GitHubCommits repo={data} />
        ) : (
          <GitHubActions repo={data} />
        )}
      </div>
    </>
  );
}

function Overview({
  repo,
  onTab,
}: {
  repo: GitHubRepo;
  onTab: (tab: Tab) => void;
}) {
  const t = useGitHubText();
  return (
    <div className="gh-scroll p-5">
      <p className="max-w-3xl text-sm leading-relaxed">
        {repo.description || t("noDescription")}
      </p>
      <div className="gh-metrics">
        {[
          { label: t("stars"), value: repo.stars, Icon: StarIcon },
          { label: t("forks"), value: repo.forks, Icon: GitBranchIcon },
          {
            label: t("openItems"),
            value: repo.openIssues,
            Icon: CircleDotIcon,
          },
        ].map((item) => (
          <div className="gh-card" key={item.label}>
            <item.Icon className="mb-3 size-4 text-muted-foreground" />
            <strong className="block text-2xl font-medium">{item.value}</strong>
            <span className="text-muted-foreground">{item.label}</span>
          </div>
        ))}
      </div>
      <div className="gh-card my-4 flex flex-wrap gap-x-8 gap-y-3">
        <span>
          {t("defaultBranch")}{" "}
          <strong className="ml-2 font-mono">
            {repo.defaultBranch || "—"}
          </strong>
        </span>
        <span>{repo.language}</span>
        <span className="text-muted-foreground">
          <GhDate value={repo.updatedAt} />
        </span>
        <span className="ml-auto text-muted-foreground">
          {repo.canPush && !repo.archived ? t("pushAccess") : t("readOnly")}
        </span>
      </div>
      <div className="gh-overview-links">
        {TABS.filter((v) => v.id !== "overview").map(({ id, Icon }) => (
          <button
            type="button"
            key={id}
            onClick={() => onTab(id)}
            className="gh-card"
          >
            <Icon className="size-5" />
            <span>{t(id)}</span>
            <span className="ml-auto text-muted-foreground">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}
