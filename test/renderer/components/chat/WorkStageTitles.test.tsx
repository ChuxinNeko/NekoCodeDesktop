import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { AgentCell } from "../../../../src/shared/agent";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { Transcript } from "../../../../src/renderer/src/components/Transcript";

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
  expect(html).toContain("规划下一步");
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


describe("current thinking between stages and planning", () => {
 test("shows only the latest returned thinking below stage headings and above planning", () => {
  const html=render();
  const position=html.indexOf('data-work-current-thinking');
  expect(position).toBeGreaterThan(html.indexOf('data-work-stage="'));
  expect(position).toBeLessThan(html.indexOf('规划下一步'));
  expect(html).toContain('aria-label="当前思考"');
  expect(html).not.toContain('>当前思考<');
  expect(html).toContain('Let&#x27;s look at the entry point');
  expect(html).not.toContain('Follow the skill');
  expect(html).toContain('max-h-[7.5em]');
  expect(html).toContain('tabindex="0"');
 });
 test("updates the text as the current assistant streams without adding a stage", () => {
  const base=cells.slice(0,-2);
  const a=render([...base,{...thought('live','Checking module boundaries'),streaming:true}]);
  const b=render([...base,{...thought('live','Checking module boundaries and request flow'),streaming:true}]);
  expect(a).toContain('Checking module boundaries');
  expect(b).toContain('Checking module boundaries and request flow');
  expect(a.match(/data-work-stage="/g)?.length).toBe(b.match(/data-work-stage="/g)?.length);
  expect(b.match(/data-work-current-thinking/g)?.length).toBe(1);
 });
 test("does not fabricate thinking when no thinking content has been returned", () => {
  const html=render([user,read('r','README.md')]);
  expect(html).not.toContain('data-work-current-thinking');
  expect(html).toContain('规划下一步');
 });
 test("the live thinking area is absent in completed history", () => {
  const html=render(cells,false);
  expect(html).not.toContain('data-work-current-thinking');
 });
});


describe("stable planning state while reasoning streams", () => {
 test("planning stays below the fixed-height thinking area from the first delta through long content", () => {
  const base=cells.slice(0,-2);
  for (const text of ['', '检查', '检查模块调用关系', '检查模块调用关系\n'.repeat(200)]) {
   const html=render([...base,{...thought('live',text),streaming:true}]);
   expect(html.match(/data-work-planning=/g)?.length).toBe(1);
   expect(html).toContain('规划下一步');
   if(text) {
    expect(html).toContain('h-[7.5em] min-h-0');
    expect(html.indexOf('data-work-current-thinking')).toBeLessThan(html.indexOf('data-work-planning'));
   }
  }
 });
 test("finishing the thinking block does not briefly remove planning before tools arrive", () => {
  const html=render([...cells,{...thought('next','即将检查调用关系'),streaming:false}]);
  expect(html).toContain('data-work-planning');
 });
 test("planning yields to actual tool execution and disappears after the run", () => {
  const executing: Extract<AgentCell,{type:'tool'}>={id:'running',type:'tool',toolName:'read',toolCallId:'running',args:{path:'README.md'},output:'',status:'running',timestamp:3};
  expect(render([...cells,executing])).not.toContain('data-work-planning');
  expect(render(cells,false)).not.toContain('data-work-planning');
 });
});
