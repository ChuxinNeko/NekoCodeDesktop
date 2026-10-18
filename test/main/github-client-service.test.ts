import { describe, expect, test } from "bun:test";
import { GitHubClientService } from "../../src/main/github-client-service";
import type { GitHubClientRequest } from "../../src/shared/github-client";

const SHA = "a".repeat(40);
const repo = "neko/project";
const rawRepo = {
  full_name: repo,
  html_url: `https://github.com/${repo}`,
  default_branch: "main",
  permissions: { push: true },
  allow_merge_commit: false,
  allow_squash_merge: true,
  allow_rebase_merge: false,
};
function fixture(
  handler: (
    url: string,
    init: RequestInit,
  ) => Response | Promise<Response> = () => Response.json(rawRepo),
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let token: string | null = "test-token";
  const service = new GitHubClientService(
    {
      resolveToken: async () => ({
        token,
        source: token ? "settings" : "anonymous",
      }),
    },
    {
      request: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({ url: String(input), init });
        return handler(String(input), init);
      }) as typeof fetch,
      timeoutMs: 1000,
      resolveRepository: async (cwd) => (cwd === "/workspace" ? repo : null),
    },
  );
  return {
    service,
    calls,
    setToken: (value: string | null) => {
      token = value;
    },
  };
}

describe("GitHub workbench service", () => {
  test("uses settings credentials on every request, allowing token renewal without exposing secrets", async () => {
    const f = fixture();
    const first = await f.service.execute({ action: "repository", repo });
    f.setToken("rotated-test-token");
    await f.service.execute({ action: "repository", repo });
    expect(new Headers(f.calls[0]!.init.headers).get("authorization")).toBe(
      "Bearer test-token",
    );
    expect(new Headers(f.calls[1]!.init.headers).get("authorization")).toBe(
      "Bearer rotated-test-token",
    );
    expect(JSON.stringify(first)).not.toContain("token");
    expect(first.mergeMethods).toEqual(["squash"]);
    expect(first.canPush).toBe(true);
    expect(f.calls[0]!.init.redirect).toBe("error");
  });

  test("requires a connection and does not fall back to anonymous writes", async () => {
    const f = fixture();
    f.setToken(null);
    await expect(
      f.service.execute({ action: "comment", repo, number: 1, body: "reply" }),
    ).rejects.toThrow("设置");
    expect(f.calls).toHaveLength(0);
  });

  test("lists repositories with pagination and projects only safe display fields", async () => {
    const f = fixture(() =>
      Response.json(
        [
          {
            ...rawRepo,
            token: "secret",
            clone_url: "https://secret@github.com/repo",
          },
        ],
        {
          headers: {
            link: '<https://api.github.com/user/repos?page=3>; rel="next"',
          },
        },
      ),
    );
    const data = await f.service.execute({ action: "repositories", page: 2 });
    expect(data.items[0]!.fullName).toBe(repo);
    expect(data.page).toBe(2);
    expect(data.hasNext).toBe(true);
    expect(f.calls[0]!.url).toContain("page=2");
    expect(JSON.stringify(data)).not.toContain("secret");
  });

  test("filters PRs out of the issues endpoint while retaining the next-page signal", async () => {
    const f = fixture(() =>
      Response.json(
        [
          { number: 1, title: "issue" },
          { number: 2, title: "PR", pull_request: {} },
        ],
        { headers: { link: '<https://api.github.com/next>; rel="next"' } },
      ),
    );
    const data = await f.service.execute({
      action: "issues",
      repo,
      state: "open",
    });
    expect(data.items.map((v) => v.number)).toEqual([1]);
    expect(data.hasNext).toBe(true);
    expect(f.calls[0]!.url).toContain("/issues?");
  });

  test("searches within the selected repository and requested thread kind", async () => {
    const f = fixture(() =>
      Response.json({
        items: [
          {
            number: 2,
            state: "closed",
            pull_request: { merged_at: "2026-10-18T12:00:00Z" },
          },
        ],
      }),
    );
    const result = await f.service.execute({
      action: "pulls",
      repo,
      state: "closed",
      query: "fix streaming",
    });
    expect(new URL(f.calls[0]!.url).searchParams.get("q")).toBe(
      `repo:${repo} is:pr is:closed fix streaming`,
    );
    expect(result.items[0]!.state).toBe("merged");
  });

  test("posts a comment using the issue discussion endpoint without altering its Markdown", async () => {
    const f = fixture(() =>
      Response.json({ id: 8, body: "**你好**\nnext", user: { login: "neko" } }),
    );
    const result = await f.service.execute({
      action: "comment",
      repo,
      number: 3,
      body: "**你好**\nnext",
    });
    expect(f.calls[0]!.url).toBe(
      `https://api.github.com/repos/${repo}/issues/3/comments`,
    );
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      body: "**你好**\nnext",
    });
    expect(result.author).toBe("neko");
  });

  test("merges only the exact reviewed head and reports unsuccessful merges as errors", async () => {
    const f = fixture(() =>
      Response.json({ merged: true, sha: SHA, message: "merged" }),
    );
    await f.service.execute({
      action: "merge",
      repo,
      number: 4,
      sha: SHA,
      method: "squash",
    });
    expect(f.calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      sha: SHA,
      merge_method: "squash",
    });
    const rejected = fixture(() =>
      Response.json({ merged: false, message: "Head changed" }),
    );
    await expect(
      rejected.service.execute({
        action: "merge",
        repo,
        number: 4,
        sha: SHA,
        method: "merge",
      }),
    ).rejects.toThrow("Head changed");
  });

  test("rejects malformed identifiers, arbitrary API URLs, invalid states and workflow operations before network I/O", async () => {
    const f = fixture();
    const invalid = [
      { action: "repository", repo: "https://evil.example/repos/x" },
      { action: "repository", repo: "../repo" },
      { action: "comments", repo, number: -1 },
      { action: "repositories", page: 0 },
      { action: "merge", repo, number: 2, sha: "main", method: "merge" },
      { action: "contents", repo, path: "../outside", ref: "main" },
      { action: "contents", repo, path: "/outside", ref: "main" },
      { action: "runAction", repo, run: 3, operation: "delete" },
      { action: "issues", repo, state: "merged" },
      {
        action: "dispatch",
        repo,
        workflow: 3,
        ref: "main",
        inputs: { count: 3 },
      },
      { action: "admin", repo },
    ];
    for (const request of invalid)
      await expect(
        f.service.execute(request as GitHubClientRequest),
      ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  test("loads UTF-8 file content without permitting binary or oversized files to be edited", async () => {
    const f = fixture(() =>
      Response.json({
        type: "file",
        name: "文档.md",
        path: "docs/文档.md",
        sha: SHA,
        encoding: "base64",
        content: Buffer.from("你好\n").toString("base64"),
        size: 7,
      }),
    );
    const file = await f.service.execute({
      action: "contents",
      repo,
      path: "docs/文档.md",
      ref: "feature/test",
    });
    expect(file.file?.text).toBe("你好\n");
    expect(file.file?.editable).toBe(true);
    expect(f.calls[0]!.url).toContain(encodeURIComponent("文档.md"));
    expect(new URL(f.calls[0]!.url).searchParams.get("ref")).toBe(
      "feature/test",
    );
    const binary = fixture(() =>
      Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from([0, 1, 2]).toString("base64"),
        size: 3,
      }),
    );
    expect(
      (
        await binary.service.execute({
          action: "contents",
          repo,
          path: "test.bin",
          ref: "main",
        })
      ).file?.editable,
    ).toBe(false);
  });

  test("commits edited content with the selected branch and original blob SHA", async () => {
    const f = fixture(() =>
      Response.json({
        commit: {
          sha: SHA,
          html_url: `https://github.com/${repo}/commit/${SHA}`,
        },
      }),
    );
    await f.service.execute({
      action: "saveFile",
      repo,
      branch: "feature",
      path: "docs/file.md",
      sha: SHA,
      text: "新内容",
      message: "Update docs",
    });
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.sha).toBe(SHA);
    expect(body.branch).toBe("feature");
    expect(body.message).toBe("Update docs");
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe("新内容");
    const oversized = fixture();
    await expect(
      oversized.service.execute({
        action: "saveFile",
        repo,
        branch: "main",
        path: "a.txt",
        sha: SHA,
        text: "文".repeat(200000),
        message: "too large",
      }),
    ).rejects.toThrow("512 KB");
    expect(oversized.calls).toHaveLength(0);
  });

  test("handles 204 responses for rerun, cancellation and dispatch", async () => {
    const f = fixture(() => new Response(null, { status: 204 }));
    for (const operation of ["rerun", "rerun-failed-jobs", "cancel"] as const) {
      expect(
        await f.service.execute({
          action: "runAction",
          repo,
          run: 123,
          operation,
        }),
      ).toEqual({ ok: true });
    }
    await f.service.execute({
      action: "dispatch",
      repo,
      workflow: 456,
      ref: "main",
      inputs: { version: "v1" },
    });
    expect(JSON.parse(String(f.calls[3]!.init.body))).toEqual({
      ref: "main",
      inputs: { version: "v1" },
    });
    expect(f.calls.every((c) => c.init.method === "POST")).toBe(true);
  });

  test("projects workflow runs, job steps, artifacts and commit file changes", async () => {
    const f = fixture((url) => {
      if (url.includes("/jobs"))
        return Response.json({
          jobs: [
            {
              id: 2,
              name: "Build",
              steps: [
                {
                  number: 1,
                  name: "Checkout",
                  status: "completed",
                  conclusion: "success",
                },
              ],
            },
          ],
        });
      if (url.includes("/artifacts"))
        return Response.json({
          artifacts: [{ id: 3, name: "app.zip", size_in_bytes: 4096 }],
        });
      if (url.includes("/commits/"))
        return Response.json({
          sha: SHA,
          commit: {
            message: "Fix",
            author: { name: "Neko", date: "2026-10-18" },
          },
          files: [
            { filename: "a.ts", additions: 2, deletions: 1, patch: "+new" },
          ],
        });
      return Response.json({
        workflow_runs: [
          {
            id: 1,
            display_title: "CI",
            status: "completed",
            conclusion: "success",
            actor: { login: "neko" },
          },
        ],
      });
    });
    expect(
      (
        await f.service.execute({
          action: "runs",
          repo,
          workflow: 5,
          status: "success",
        })
      ).items[0]!.conclusion,
    ).toBe("success");
    expect(
      (await f.service.execute({ action: "jobs", repo, run: 1 })).items[0]!
        .steps[0]!.name,
    ).toBe("Checkout");
    expect(
      (await f.service.execute({ action: "artifacts", repo, run: 1 })).items[0]!
        .url,
    ).toBe(`https://github.com/${repo}/actions/runs/1/artifacts/3`);
    expect(
      (await f.service.execute({ action: "commit", repo, sha: SHA })).files
        .items[0]!.patch,
    ).toBe("+new");
  });

  test("downloads signed job logs without forwarding the GitHub credential", async () => {
    const f = fixture((url) =>
      url.startsWith("https://api.github.com")
        ? new Response(null, {
            status: 302,
            headers: {
              location: "https://logs.actions.githubusercontent.com/result",
            },
          })
        : new Response("\u001b[31mfailed\u001b[0m"),
    );
    const log = await f.service.execute({ action: "jobLog", repo, job: 7 });
    expect(log.text).toBe("failed");
    expect(f.calls).toHaveLength(2);
    expect(
      new Headers(f.calls[1]!.init.headers).get("authorization"),
    ).toBeNull();
    const untrusted = fixture(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/log" },
        }),
    );
    await expect(
      untrusted.service.execute({ action: "jobLog", repo, job: 7 }),
    ).rejects.toThrow("unsupported");
    expect(untrusted.calls).toHaveLength(1);
  });

  test("redacts the resolved token from remote errors and explains missing permissions", async () => {
    const f = fixture(() =>
      Response.json({ message: "test-token rejected" }, { status: 500 }),
    );
    await expect(
      f.service.execute({ action: "repository", repo }),
    ).rejects.toThrow("[redacted]");
    const denied = fixture(() =>
      Response.json(
        { message: "Resource not accessible by integration" },
        { status: 403 },
      ),
    );
    await expect(
      denied.service.execute({ action: "repository", repo }),
    ).rejects.toThrow("Actions 权限");
  });

  test("times out even if the transport never settles after abort", async () => {
    const service = new GitHubClientService(
      { resolveToken: async () => ({ token: "test", source: "settings" }) },
      {
        timeoutMs: 10,
        request: (() => new Promise(() => {})) as unknown as typeof fetch,
      },
    );
    await expect(
      service.execute({ action: "repository", repo }),
    ).rejects.toThrow("超时");
    await expect(
      service.execute({ action: "jobLog", repo, job: 1 }),
    ).rejects.toThrow("超时");
  });

  test("resolves a local checkout without reading or returning its remote credentials", async () => {
    const f = fixture();
    expect(
      await f.service.execute({
        action: "workspaceRepository",
        cwd: "/workspace",
      }),
    ).toBe(repo);
    expect(f.calls).toHaveLength(0);
  });
});
