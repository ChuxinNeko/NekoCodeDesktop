import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { AgentCell } from "../../../../src/shared/agent";
import type { WorkItem } from "../../../../src/shared/transcript";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { Transcript } from "../../../../src/renderer/src/components/Transcript";
import { todoItems } from "../../../../src/renderer/src/components/chat/TodoList";
import { WorkflowPanel } from "../../../../src/renderer/src/components/chat/WorkflowPanel";
import { groupWorkStages } from "../../../../src/renderer/src/lib/workStages";

const todo = (id: string, status = "pending"): Extract<AgentCell, { type: "tool" }> => ({
 id, type: "tool", toolCallId: id, toolName: "todo_write", args: { todos: [{ id: "step", text: "检查输入框", status }] }, output: "ok", status: "done", timestamp: 1,
});
describe("transcript todo snapshots", () => {
 test("separates updates from other stages and automatically opens their bodies", () => {
  const cells: AgentCell[] = [todo("first"), { id: "read", type: "tool", toolName: "read", toolCallId: "read", args: { path: "app.ts" }, output: "code", status: "done", timestamp: 2 }, todo("last", "completed")];
  const items: WorkItem[] = cells.map(cell => ({ kind: "tool", id: cell.id, cell: cell as Extract<AgentCell, { type: "tool" }> }));
  const stages = groupWorkStages(items);
  expect(stages.map(stage => Boolean(stage.todo))).toEqual([true, false, true]);
  const html = renderToString(<I18nProvider><Transcript cells={[{ id: "user", type: "user", text: "修改", timestamp: 0 }, ...cells]} streaming /></I18nProvider>);
  expect(html.match(/data-slot="transcript-todos"/g)).toHaveLength(2);
  expect(html).toContain("更新待办事项");
  expect(html).toContain("line-through");
  expect(todoItems(cells[0] as ReturnType<typeof todo>)?.[0].status).toBe("pending");
 });
 test("rejects failed or malformed updates instead of displaying them as applied", () => {
  expect(todoItems({ ...todo("failed"), status: "error" })).toBeNull();
  expect(todoItems({ ...todo("bad"), args: { todos: [null] } })).toBeNull();
  expect(todoItems({ ...todo("clear"), args: { todos: [] } })).toEqual([]);
 });
 test("a todo-only workflow no longer renders a bottom rail", () => {
  const html = renderToString(<I18nProvider><WorkflowPanel workflow={{ todos: todoItems(todo("one"))!, tasks: [], explorers: [], request: null }} /></I18nProvider>);
  expect(html).not.toContain('data-slot="workflow-rail"');
 });
});
