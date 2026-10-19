import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { AgentCell } from "../../../../src/shared/agent";
import { groupWorkStages } from "../../../../src/renderer/src/lib/workStages";
import type { WorkItem } from "../../../../src/shared/transcript";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { Transcript, WorkStageDetails } from "../../../../src/renderer/src/components/Transcript";

const thought = (id: string, thinking: string): Extract<AgentCell, { type: "assistant" }> => ({ id, type: "assistant", text: "", thinking, streaming: false, timestamp: 1 });
const read = (id: string, path: string): AgentCell => ({ id, type: "tool", toolName: "read", toolCallId: id, args: { path }, output: "file content", status: "done", timestamp: 2 });
const user: AgentCell = { id: "u", type: "user", text: "请你了解一下这个项目", timestamp: 0 };
const cells = [user, thought("a", "### 读取项目入口"), read("r1", "package.json"), thought("b", "**Follow the skill**"), read("r2", "skills/SKILL.md"), thought("c", "Let's look at the entry point server.mjs, and the other modules"), read("r3", "src/server.mjs")];
const render = (value = cells, streaming = true) => renderToString(<I18nProvider><Transcript cells={value} streaming={streaming} /></I18nProvider>);

describe("localized workflow headings in Transcript", () => {
 test("renders one exploration phase and the waiting state instead of per-file headings", () => {
  const html = render();
  expect(html).toContain("读取项目入口");
  expect(html).not.toContain("读取 SKILL.md");
  expect(html).not.toContain("读取 server.mjs");
  expect(html).not.toContain("规划下一步");
  expect(html).toContain("已工作");
  expect(html.match(/data-work-stage="/g)?.length).toBe(1);
  for (const raw of ["Follow the skill", "Planning Next Step", "Working for"]) expect(html).not.toContain(raw);
 });
 test("keeps the header and tool count localized for completed history", () => {
  const answer: AgentCell = { id: "answer", type: "assistant", text: "这是项目的结构。", thinking: "", streaming: false, timestamp: 3 };
  const html = render([...cells, answer], false);
  expect(html).toContain("工作用时");
  expect(html).toContain("3 次工具调用");
  expect(html).not.toContain("Worked for");
  expect(html).not.toContain("tool calls");
  expect(html).toContain("这是项目的结构");
 });
});


describe("stage presentation", () => {
 test("hides reasoning below headings and keeps a vertical rail", () => {
  const html = render();
  expect(html).not.toContain('data-work-current-thinking');
  expect(html).not.toContain('Let&#x27;s look at the entry point');
  expect(html).toContain('data-work-stage-rail');
 });
 test("counts successful edits only within their own stage", () => {
  const edit = (id: string, status: "done" | "error" | "running", diff: string): AgentCell => ({ id, type: "tool", toolName: "edit", toolCallId: id, args: { path: "app.ts" }, details: { diff }, output: "", status, timestamp: 2 });
  const html = render([user, thought("a", "### 修改入口"), edit("one", "done", "-1 old\n+1 new\n+2 next"), edit("bad", "error", "+1 ignored"), edit("live", "running", "+1 pending"), thought("b", "### 调整配置"), edit("two", "done", "-1 old\n-2 old")]);
  const stages = html.replace(/<!--.*?-->/g, '').split('data-work-stage="').slice(1);
  expect(stages).toHaveLength(2);
  // Two completed additions plus one running addition; failed edits are excluded.
  expect(stages[0]).toContain('aria-label="3"');
  expect(stages[0]).toContain('aria-label="1"');
  expect(stages[1]).toContain('aria-label="0"');
  expect(stages[1]).toContain('aria-label="2"');
 });
 test("read-only stages have no diff statistics", () => {
  expect(render()).not.toContain('data-slot="diff-stat"');
 });
});


describe("stable planning state while reasoning streams", () => {
 test("does not show a new planning stage while the model continues reasoning", () => {
  const base=cells.slice(0,-2);
  for (const text of ['', '检查', '检查模块调用关系', '检查模块调用关系\n'.repeat(200)]) {
   const html=render([...base,{...thought('live',text),streaming:true}]);
   expect(html).not.toContain('data-work-planning');
   expect(html).not.toContain('规划下一步');
   expect(html).not.toContain('data-work-current-thinking');
   expect(html).not.toContain('h-[7.5em]');
  }
 });
 test("finishing reasoning does not imply the stage has completed", () => {
  const html=render([...cells,{...thought('next','即将检查调用关系'),streaming:false}]);
  expect(html).not.toContain('data-work-planning');
 });
 test("planning yields to actual tool execution and disappears after the run", () => {
  const executing: Extract<AgentCell,{type:'tool'}>={id:'running',type:'tool',toolName:'read',toolCallId:'running',args:{path:'README.md'},output:'',status:'running',timestamp:3};
  expect(render([...cells,executing])).not.toContain('data-work-planning');
  expect(render(cells,false)).not.toContain('data-work-planning');
 });
});


test("a failed command does not color or label the whole stage as failed", () => {
 const failed: AgentCell = {...read("failed", "README.md"), type:"tool", toolName:"bash", toolCallId:"failed", args:{command:"exit 1"}, output:"failed", status:"error"};
 const html = render([...cells, failed]);
 const header = html.split('data-work-stage="')[1].split('</button>')[0];
 expect(header).not.toContain('text-destructive');
 expect(header).not.toContain('bg-destructive');
 expect(header).not.toContain('失败');
 expect(html).not.toContain('data-work-planning');
});


describe("reasoning disclosure content", () => {
 test("empty thinking uses a non-expandable status, not a blank secondary heading", () => {
  for (const text of ["", " \n\t", "### "]) {
   const html = render([user, {...thought("empty", text), streaming: true}]);
   expect(html).not.toContain("data-work-stage=");
   expect(html).not.toContain("data-work-stage-details");
   expect(html).not.toContain("思考与规划");
   // The top-level work header may remain; the pending status has no disclosure.
   expect(html).toContain('role="status"');
   expect(html).toContain("正在准备下一步操作");
  }
 });
 test("expanded stage details contain the original thinking instead of filtering it away", () => {
  const text = "### 检查组件调用关系\n先确认消息正文如何进入渲染组件，再保留现有交互。";
  const cell = thought("reason", text);
  const items: WorkItem[] = [{kind:"thinking",id:"reason-thinking",cell}, {kind:"tool",id:"read",cell:read("read", "src/components/Transcript.tsx") as Extract<AgentCell,{type:"tool"}>}];
  const stage = groupWorkStages(items)[0];
  const html = renderToString(<I18nProvider><WorkStageDetails stage={stage} active /></I18nProvider>);
  expect(html).toContain("data-work-stage-details");
  expect(html).toContain("先确认消息正文如何进入渲染组件，再保留现有交互。");
  expect(html).toContain("检查组件调用关系");
  expect(html).toContain("<pre");
  expect(html).toContain("Transcript.tsx");
 });
 test("nonempty internal reasoning is available in details while its title stays Chinese", () => {
  const cell = thought("reason", "Evaluating implementation details\n这里有可展示的真实思考正文。");
  const html = render([user, {...cell, streaming:true}]);
  expect(html).toContain("梳理实现方案与约束");
  expect(html).not.toContain("Evaluating implementation details");
  const stage = groupWorkStages([{kind:"thinking",id:"reason-thinking",cell}])[0];
  const details = renderToString(<I18nProvider><WorkStageDetails stage={stage} active /></I18nProvider>);
  expect(details).toContain("这里有可展示的真实思考正文。");
 });
});
