import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { markdownRemarkPlugins, markdownRehypePlugins } from "../../lib/markdownPlugins";
import type { GitHubFileChange } from "../../../../shared/github-client";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import {
  ChevronLeftIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
} from "../../lib/icons";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

export function useGitHubText() {
  const { t } = useTranslation();
  return (key: GitHubTextKey) => t(`githubClient.${key}`);
}
// Keeps keys checked against the app's translation catalog.
type GitHubTextKey =
  keyof typeof import("../../i18n/locales/en").en extends infer K
    ? K extends `githubClient.${infer S}`
      ? S
      : never
    : never;

export function GhError({
  error,
  retry,
}: {
  error?: string | null;
  retry?: () => void;
}) {
  const t = useGitHubText();
  return error ? (
    <div role="alert" className="gh-error">
      <span>{error}</span>
      {retry && (
        <Button size="xs" variant="ghost" onClick={retry}>
          {t("retry")}
        </Button>
      )}
    </div>
  ) : null;
}
export function GhEmpty({ children }: { children: ReactNode }) {
  return <div className="gh-empty">{children}</div>;
}
export function GhLoading() {
  return (
    <div className="gh-empty" role="status">
      <Spinner className="size-4" />
    </div>
  );
}
export function GhMore({
  more,
  loading,
  hasNext,
}: {
  more: () => void;
  loading: boolean;
  hasNext: boolean;
}) {
  const t = useGitHubText();
  return hasNext ? (
    <Button
      className="mx-auto my-3"
      size="sm"
      variant="ghost"
      disabled={loading}
      onClick={more}
    >
      {loading && <Spinner className="size-3" />}
      {t("loadMore")}
    </Button>
  ) : null;
}
export function GhExternal({ url }: { url: string }) {
  const t = useGitHubText();
  return url ? (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={t("openGithub")}
      onClick={() => void api.openExternal(url)}
    >
      <ExternalLinkIcon className="size-3.5" />
    </Button>
  ) : null;
}
export function GhRefresh({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  const t = useGitHubText();
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={t("refresh")}
      disabled={disabled}
      onClick={onClick}
    >
      <RefreshCwIcon className="size-3.5" />
    </Button>
  );
}
export function GhBack({ onClick }: { onClick: () => void }) {
  const t = useGitHubText();
  return (
    <Button className="gh-back" size="xs" variant="ghost" onClick={onClick}>
      <ChevronLeftIcon className="size-3" />
      {t("back")}
    </Button>
  );
}
export function GhMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown gh-markdown">
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}
        components={{
          a: ({ href, children }) => (
            <button
              type="button"
              className="gh-inline-link"
              onClick={() => {
                if (href && /^https?:\/\//i.test(href))
                  void api.openExternal(href);
              }}
            >
              {children}
            </button>
          ),
          // The desktop CSP permits local/data images; remote images stay as links.
          img: ({ src, alt }) => (
            <span className="text-muted-foreground">
              {alt || "Image"}
              {typeof src === "string" && /^https:\/\//i.test(src) && (
                <button
                  type="button"
                  className="gh-inline-link ml-1"
                  onClick={() => void api.openExternal(src)}
                >
                  ↗
                </button>
              )}
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
export function GhStatus({ value }: { value: string }) {
  const t = useGitHubText();
  const label =
    (
      {
        open: t("open"),
        closed: t("closed"),
        merged: t("merged"),
        draft: t("draft"),
        success: t("success"),
        failure: t("failure"),
        cancelled: t("cancelled"),
        queued: t("queued"),
        in_progress: t("running"),
        completed: t("completed"),
        neutral: t("neutral"),
        skipped: t("skipped"),
        timed_out: t("timedOut"),
        waiting: t("waiting"),
      } as Record<string, string>
    )[value] || value;
  return (
    <span className="gh-status" data-state={value}>
      {label || "—"}
    </span>
  );
}
export function GhDate({ value }: { value: string }) {
  const { language } = useTranslation();
  const date = new Date(value);
  return (
    <time
      dateTime={value}
      title={
        Number.isNaN(date.getTime()) ? value : date.toLocaleString(language)
      }
    >
      {Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(language)}
    </time>
  );
}
export function GhFiles({ files }: { files: GitHubFileChange[] }) {
  const t = useGitHubText();
  return (
    <div className="gh-files">
      {files.map((file) => (
        <details key={file.path} className="gh-file-diff">
          <summary>
            <span className="min-w-0 break-all font-mono">{file.path}</span>
            <span className="ml-auto whitespace-nowrap">
              <span className="text-[var(--success)]">+{file.additions}</span>{" "}
              <span className="text-destructive">−{file.deletions}</span>
            </span>
          </summary>
          {file.patch ? (
            <pre className="gh-code">
              {file.patch.split("\n").map((line, index) => (
                <div
                  key={index}
                  className={
                    line.startsWith("+")
                      ? "gh-diff-add"
                      : line.startsWith("-")
                        ? "gh-diff-delete"
                        : ""
                  }
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          ) : (
            <p className="p-3 text-muted-foreground">{t("noPatch")}</p>
          )}
        </details>
      ))}
    </div>
  );
}
