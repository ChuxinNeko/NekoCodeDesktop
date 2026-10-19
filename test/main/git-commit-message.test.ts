import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommitMessage } from "../../src/main/git-commit-message";
import type { ModelCallRuntime } from "../../src/main/model-call";

const repos: string[] = [];
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
function repo(initialCommit = true) {
  const cwd = mkdtempSync(join(tmpdir(), "neko-commit-message-"));
  repos.push(cwd);
  sh(cwd, "init", "-q", "-b", "main");
  writeFileSync(join(cwd, "selected.ts"), "export const value = 1;\n");
  if (initialCommit) {
    sh(cwd, "add", "selected.ts");
    sh(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "feat: initial value");
  }
  return cwd;
}
afterAll(() => repos.forEach(cwd => rmSync(cwd, { recursive: true, force: true })));

function model(answer = '{"summary":"更新数值","description":"- 将数值调整为 3"}') {
  const calls: { systemPrompt: string; messages: { content: string }[] }[] = [];
  const runtime = {
    getModel: () => ({ provider: "test", id: "model", maxTokens: 8192 }),
    getAvailable: async () => [],
    completeSimple: async (_model: unknown, context: typeof calls[number]) => {
      calls.push(context);
      return { content: [{ type: "text", text: answer }], stopReason: "stop" };
    },
  } as unknown as ModelCallRuntime;
  return { calls, runtime };
}

describe("generate review commit message", () => {
  test("uses only selected changes, includes staged and unstaged edits, preserves index", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "selected.ts"), "export const value = 2;\n");
    sh(cwd, "add", "selected.ts");
    writeFileSync(join(cwd, "selected.ts"), "export const value = 3;\n");
    writeFileSync(join(cwd, "excluded.txt"), "PRIVATE EXCLUDED CONTENT\n");
    const status = sh(cwd, "status", "--porcelain");
    const index = readFileSync(join(cwd, ".git", "index"));
    const { runtime, calls } = model();
    expect(await generateCommitMessage({ cwd, files: ["selected.ts"], language: "zh-CN" }, runtime, "test/model"))
      .toEqual({ summary: "更新数值", description: "- 将数值调整为 3", truncated: false });
    const payload = JSON.parse(calls[0].messages[0].content);
    expect(payload.files.map((file: { path: string }) => file.path)).toEqual(["selected.ts"]);
    expect(payload.diffs[0].patch).toContain("-export const value = 1;");
    expect(payload.diffs[0].patch).toContain("+export const value = 3;");
    expect(calls[0].messages[0].content).not.toContain("PRIVATE EXCLUDED CONTENT");
    expect(calls[0].systemPrompt).toContain("Simplified Chinese");
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index);
    expect(sh(cwd, "status", "--porcelain")).toBe(status);
  });

  test("reads untracked additions before the first commit", async () => {
    const cwd = repo(false);
    const { runtime, calls } = model();
    await generateCommitMessage({ cwd, files: ["selected.ts"], language: "en" }, runtime, "test/model");
    expect(JSON.parse(calls[0].messages[0].content).diffs[0].patch).toContain("+export const value = 1;");
    expect(calls[0].systemPrompt).toContain("English");
    expect(sh(cwd, "diff", "--cached")).toBe("");
  });

  test("includes deletion and rename metadata", async () => {
    const cwd = repo();
    sh(cwd, "mv", "selected.ts", "renamed.ts");
    const { runtime, calls } = model();
    await generateCommitMessage({ cwd, files: ["renamed.ts"], language: "en" }, runtime, "test/model");
    expect(JSON.parse(calls[0].messages[0].content).files[0].oldPath).toBe("selected.ts");
    expect(JSON.parse(calls[0].messages[0].content).diffs[0].patch).toContain("rename to renamed.ts");
    sh(cwd, "reset", "--hard", "HEAD");
    rmSync(join(cwd, "selected.ts"));
    await generateCommitMessage({ cwd, files: ["selected.ts"], language: "en" }, runtime, "test/model");
    expect(JSON.parse(calls[1].messages[0].content).diffs[0].patch).toContain("deleted file mode");
  });

  test("caps oversized patches and reports truncation", async () => {
    const cwd = repo(false);
    writeFileSync(join(cwd, "selected.ts"), "long new line\n".repeat(2000));
    const { runtime, calls } = model();
    const result = await generateCommitMessage({ cwd, files: ["selected.ts"], language: "en" }, runtime, "test/model");
    expect(result.truncated).toBe(true);
    expect(JSON.parse(calls[0].messages[0].content).diffs[0].patch.length).toBe(12_000);
  });

  test("rejects missing selections before calling a model", async () => {
    const cwd = repo(false);
    const { runtime, calls } = model();
    await expect(generateCommitMessage({ cwd, files: [], language: "en" }, runtime, "test/model")).rejects.toThrow("Invalid");
    await expect(generateCommitMessage({ cwd, files: ["missing.txt"], language: "en" }, runtime, "test/model")).rejects.toThrow("Refresh");
    expect(calls).toHaveLength(0);
  });

  test("rejects malformed, empty and multiline titles", async () => {
    const cwd = repo(false);
    for (const answer of ["not json", "null", '{"summary":" ","description":""}', '{"summary":"first\\nsecond","description":""}']) {
      const { runtime } = model(answer);
      await expect(generateCommitMessage({ cwd, files: ["selected.ts"], language: "en" }, runtime, "test/model")).rejects.toThrow("invalid commit message");
    }
  });
});
