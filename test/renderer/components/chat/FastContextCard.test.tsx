import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { AgentCell } from "../../../../src/shared/agent";
import type { ExplorerRun } from "../../../../src/shared/workflow";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { FastContextCard } from "../../../../src/renderer/src/components/chat/FastContextCard";

const cell: Extract<AgentCell, { type: "tool" }> = { id: "search", toolCallId: "search-call", type: "tool", toolName: "code_search", args: { query: "定位登录入口" }, output: "- `src/login.ts:4-12` — 登录入口\n\n完整搜索报告", status: "done", timestamp: 3000 };
const run: ExplorerRun = { id: "run", toolCallId: cell.toolCallId, query: "定位登录入口", model: "provider/search-model", status: "running", startedAt: 1000, steps: [{ id: "read", kind: "tool", toolName: "read", args: '{"path":"src/login.ts"}', status: "running", startedAt: 1000 }] };
const render = (node: React.ReactNode) => renderToString(<I18nProvider>{node}</I18nProvider>);

describe("compact Fast Context card", () => {
 test("running header shares subagent status and keeps details out of the transcript", () => {
  const html = render(<FastContextCard cell={{ ...cell, status: "running", output: "" }} run={run} onOpenDetails={() => {}} />);
  expect(html).toContain("task-pixel-loader");
  expect(html).toContain("search-model");
  expect(html).toContain("定位登录入口");
  expect(html).not.toContain('aria-expanded=');
  expect(html).not.toContain("fast-context-scan");
 });
 test("history remains compact without a live run", () => {
  const html = render(<FastContextCard cell={cell} onOpenDetails={() => {}} />);
  expect(html).toContain("text-emerald-500");
  expect(html).not.toContain("完整搜索报告");
 });
 test("docked history shows the report and clickable file locations", () => {
  const html = render(<FastContextCard cell={cell} docked onOpenFile={() => {}} />);
  expect(html).toContain("完整搜索报告");
  expect(html).toContain("login.ts");
  expect(html).toContain('data-fast-context="detail"');
  expect(html).toContain('aria-expanded="true"');
 });
 test("failure and cancellation stay distinct", () => {
  expect(render(<FastContextCard cell={{ ...cell, status: "error" }} />)).toContain("text-destructive");
  expect(render(<FastContextCard cell={{ ...cell, status: "error" }} run={{ ...run, status: "cancelled" }} />)).toContain("text-amber-500");
 });
});
