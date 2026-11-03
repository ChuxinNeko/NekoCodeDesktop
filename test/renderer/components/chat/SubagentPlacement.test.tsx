import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { WorkflowTask } from "../../../../src/shared/workflow";
import type { AgentCell } from "../../../../src/shared/agent";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { WorkflowPanel } from "../../../../src/renderer/src/components/chat/WorkflowPanel";
import { Transcript } from "../../../../src/renderer/src/components/Transcript";

const task = (id: string, status: WorkflowTask["status"]): WorkflowTask => ({ id, description: `task-${id}`, kind: "explore", writablePaths: [], status, startedAt: 1000, endedAt: status === "running" ? undefined : 2000, steps: [], result: "report" });
const render = (node: React.ReactNode) => renderToString(<I18nProvider>{node}</I18nProvider>);
const panel = (tasks: WorkflowTask[]) => render(<WorkflowPanel workflow={{ request: null, todos: [], tasks }} onOpenTask={() => {}} />);

describe("subagent placement", () => {
 test("bottom activity strip includes running tasks only", () => {
  const html = panel([task("live", "running"), task("done", "completed"), task("error", "failed"), task("stop", "cancelled")]);
  expect(html).toContain('data-slot="background-task-strip"');
  expect(html).toContain("task-live");
  for (const name of ["task-done", "task-error", "task-stop"]) expect(html).not.toContain(name);
  expect(html).not.toContain('data-slot="workflow-rail"');
 });
 test("bottom strip disappears after all tasks finish", () => {
  expect(panel([task("done", "completed")])).not.toContain("background-task-strip");
 });
 test("more than three running tasks initially fold into a count", () => {
  const html = panel([1, 2, 3, 4].map(id => task(String(id), "running")));
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('data-task-summary="workflow"');
 });
 test("completed task and Fast Context cards remain visible in collapsed history", () => {
  const cells: AgentCell[] = [
   { id: "u", type: "user", text: "检查项目", timestamp: 0 },
   { id: "t", type: "tool", toolCallId: "t", toolName: "task", args: {}, output: '{"id":"done"}', status: "done", timestamp: 1 },
   { id: "s", type: "tool", toolCallId: "s", toolName: "code_search", args: { query: "搜索入口" }, output: "report", status: "done", timestamp: 2 },
   { id: "a", type: "assistant", text: "完成", thinking: "", streaming: false, timestamp: 3 },
  ];
  const html = render(<Transcript cells={cells} tasks={[task("done", "completed")]} streaming={false} onOpenTask={() => {}} onOpenExplorer={() => {}} />);
  expect(html).toContain('data-task-id="done"');
  expect(html).toContain('data-fast-context="summary"');
  expect(html.match(/data-agent-stage=""/g)).toHaveLength(2);
  expect(html.match(/data-task-id="done"/g)).toHaveLength(1);
 });
});
