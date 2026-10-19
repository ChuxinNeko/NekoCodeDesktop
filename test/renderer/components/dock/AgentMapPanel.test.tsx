import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentSnapshot } from "../../../../src/shared/agent";
import { AgentMapPanel } from "../../../../src/renderer/src/components/dock/AgentMapPanel";
import { I18nProvider } from "../../../../src/renderer/src/i18n";

const snapshot = {
  session: { id: "session", title: "Build a map" }, cells: [], streaming: false,
  modelKey: "provider/main-model", workMode: "agent", agentPhase: "execute",
  workflow: { request: null, todos: [], tasks: [{ id: "same", kind: "worker", description: "Implement the graph", status: "running", startedAt: 1, writablePaths: [], steps: [] }],
    explorers: [{ id: "same", query: "Find relevant code", model: "provider/explorer-model", status: "completed", startedAt: 1, endedAt: 2, steps: [] }] },
} as unknown as AgentSnapshot;
const render = (value: AgentSnapshot | null = snapshot) => renderToStaticMarkup(<I18nProvider><AgentMapPanel snapshot={value} onOpenTask={() => undefined} /></I18nProvider>);

describe("agent map cards", () => {
  test("the second-level heading remains available without a session", () => {
    const html = render(null);
    expect(html).toMatch(/<h2[^>]*>Agent 地图<\/h2>/);
    expect(html).toContain("打开一个会话");
    expect(html).not.toContain("data-map-node");
  });

  test("shows model, status, task descriptions and independent task actions", () => {
    const html = render();
    expect(html).toContain("main-model");
    expect(html).toContain("explorer-model");
    expect(html).toContain("Implement the graph");
    expect(html).toContain("查看详情");
    expect(html).toContain('data-tone="active"');
    expect(html).toContain('data-tone="done"');
    expect(html).toContain('data-map-node="task:same"');
    expect(html).toContain('data-map-node="explorer:same"');
    expect(html).not.toContain("undefined");
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  });

  test("keeps concrete tool names, arguments and outputs out of map cards", () => {
    const value = {
      ...snapshot, streaming: true,
      cells: [{ id: "tool", type: "tool", toolCallId: "tool", toolName: "main_secret_tool", args: { path: "hidden-main-path" }, output: "hidden-main-output", status: "running", timestamp: 1 }],
      workflow: { ...snapshot.workflow, tasks: [{ ...snapshot.workflow.tasks[0], steps: [
        { id: "step", kind: "tool", toolName: "worker_secret_tool", args: "hidden-worker-args", output: "hidden-worker-output", status: "running", startedAt: 1 },
      ] }] },
    } as AgentSnapshot;
    const html = render(value);
    expect(html).toContain("正在执行任务");
    for (const detail of ["main_secret_tool", "hidden-main-path", "hidden-main-output", "worker_secret_tool", "hidden-worker-args", "hidden-worker-output"]) {
      expect(html).not.toContain(detail);
    }
    // Both worker and explorer cards are accessible activation targets, with no nested buttons.
    expect(html).toMatch(/data-map-node="task:same"[^>]*role="button"/);
    expect(html).toMatch(/data-map-node="explorer:same"[^>]*role="button"/);
  });

  test("exposes keyboard movement and zoom, fit and reset controls", () => {
    const html = render();
    expect(html).toContain('aria-label="放大"');
    expect(html).toContain('aria-label="缩小"');
    expect(html).toContain('aria-label="适应视图"');
    expect(html).toContain('aria-label="重置布局"');
    expect(html).toContain("使用方向键移动节点");
    expect(html).toContain("Ctrl / ⌘ + 滚轮缩放");
  });
});
