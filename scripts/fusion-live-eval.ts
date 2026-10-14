/** Real SDK/workflow comparison. Credentials are read from the environment, never saved. */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowSession } from "../src/main/workflow-runtime";

const key = process.env.NEKO_FUSION_EVAL_KEY;
if (!key) throw new Error("Set NEKO_FUSION_EVAL_KEY for this process only");
delete process.env.NEKO_FUSION_EVAL_KEY;
const endpoint = process.env.NEKO_FUSION_EVAL_ENDPOINT ?? "https://model.nekofun.top/v1/chat/completions";
const baseUrl = endpoint.replace(/\/chat\/completions\/?$/, "");
const leadId = process.env.NEKO_FUSION_EVAL_LEAD ?? "deepseek-v4.1-flash";
const sideId = process.env.NEKO_FUSION_EVAL_SIDEKICK ?? "qwen3.8-flash";
const requestedOrchestration = process.env.NEKO_FUSION_EVAL_ORCHESTRATION ?? "engine";
if (!["engine", "parallel", "inline"].includes(requestedOrchestration)) throw new Error("Unknown Fusion orchestration");
const orchestration = requestedOrchestration as "engine" | "parallel" | "inline";
const output = process.env.NEKO_FUSION_EVAL_OUTPUT ?? await mkdtemp(join(tmpdir(), "neko-fusion-live-"));
await mkdir(output, { recursive: true });
console.log(JSON.stringify({ event: "output", path: output }));

type NetworkCall = { mode: string; requestedModel: string; returnedModel?: string; status: number;
  durationMs?: number; usage?: Record<string, unknown>; error?: string; };
const calls: NetworkCall[] = [];
const captures: Promise<void>[] = [];
const originalFetch = globalThis.fetch;
let mode = "preflight";
// Capture the gateway's own streaming usage independently of PI's normalization.
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/chat/completions")) return originalFetch(input, init);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  const started = Date.now();
  const call: NetworkCall = { mode, requestedModel: body.model, status: 0 };
  calls.push(call);
  let response: Response;
  try { response = await originalFetch(input, init); }
  catch (error) {
    call.durationMs = Date.now() - started;
    call.error = String(error).replaceAll(key!, "[redacted]");
    console.log(JSON.stringify({ event: "upstream_error", ...call }));
    throw error;
  }
  call.status = response.status;
  const copy = response.clone();
  const capture = (async () => {
    if (!response.ok) { call.error = (await copy.text()).slice(0, 800).replaceAll(key!, "[redacted]"); return; }
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const json = await copy.json() as { model?: string; usage?: Record<string, unknown> };
      call.returnedModel = json.model; call.usage = json.usage;
    } else {
      const reader = copy.body!.getReader(); const decoder = new TextDecoder(); let pending = "";
      const parse = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim(); if (!data || data === "[DONE]") return;
        try { const json = JSON.parse(data); if (json.model) call.returnedModel = json.model;
          if (json.usage) call.usage = json.usage; } catch { /* SSE comments/partial data */ }
      };
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n"); pending = lines.pop()!; lines.forEach(parse);
      }
      parse(pending);
    }
    call.durationMs = Date.now() - started;
    console.log(JSON.stringify({ event: "upstream_usage", ...call }));
  })().catch((error) => { call.error = String(error).replaceAll(key!, "[redacted]"); });
  captures.push(capture);
  return response;
}) as typeof fetch;

for (const model of [leadId, sideId]) {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply exactly OK." }], max_tokens: 32,
      ...(model === leadId ? { thinking: { type: "disabled" } } : { enable_thinking: false }) }), signal: AbortSignal.timeout(60000) });
  const json = await response.json() as { error?: unknown; choices?: { message?: { content?: string } }[] };
  console.log(JSON.stringify({ event: "preflight", model, status: response.status, response: response.ok ? json.choices?.[0]?.message?.content : "API error" }));
  if (!response.ok) { await Promise.all(captures); await writeFile(join(output, "network.json"), JSON.stringify(calls, null, 2)); throw new Error(`Preflight HTTP ${response.status} for ${model}`); }
}

const fixtures: Record<string, string> = {
  "package.json": JSON.stringify({ name: "cart-quote-eval", private: true, type: "module", scripts: { test: "bun test test" } }, null, 2),
  "src/cart.ts": `export interface Item { sku: string; name: string; unitPriceCents: number; quantity: number }
export function validateCart(items: readonly Item[]): void { throw new Error("TODO") }
export function setQuantity(items: readonly Item[], sku: string, quantity: number): Item[] { throw new Error("TODO") }
`,
  "src/pricing.ts": `import type { Item } from "./cart";
export type Coupon = { kind: "percent"; value: number } | { kind: "fixed"; value: number };
export interface Options { coupon?: Coupon; taxBasisPoints: number; shippingCents: number; freeShippingThresholdCents: number }
export interface Quote { subtotalCents: number; discountCents: number; taxableCents: number; taxCents: number; shippingCents: number; totalCents: number }
export function quote(items: readonly Item[], options: Options): Quote { throw new Error("TODO") }
`,
  "src/csv.ts": `import type { Item } from "./cart";
export function exportCsv(items: readonly Item[]): string { throw new Error("TODO") }
`,
  "src/index.ts": `// Export the public API here.\n`,
  "test/cart.test.ts": `import { test, expect } from "bun:test";
import { validateCart, setQuantity } from "../src/cart";
import { quote } from "../src/pricing";
import { exportCsv } from "../src/csv";
const items = [{ sku: "A", name: "Apple", unitPriceCents: 101, quantity: 2 }];
test("valid cart", () => expect(() => validateCart(items)).not.toThrow());
test("immutable quantity", () => { expect(setQuantity(items, "A", 3)[0].quantity).toBe(3); expect(items[0].quantity).toBe(2); });
test("quote", () => expect(quote(items, { taxBasisPoints: 1000, shippingCents: 50, freeShippingThresholdCents: 1000 }).totalCents).toBe(272));
test("CSV", () => expect(exportCsv(items)).toBe('sku,name,unitPriceCents,quantity,lineTotalCents\\r\\nA,Apple,101,2,202\\r\\n'));
`,
};
const prompt = `完成这个 TypeScript 购物车报价与 CSV 导出库，修改现有 src/cart.ts、src/pricing.ts、src/csv.ts、src/index.ts，并补充 test/cart.test.ts 的边界测试。文件位置已知，直接读取必要原文。不要安装依赖，不提交 Git，不修改 package.json。使用 bun test test 验证。
要求：
1. validateCart：items 为数组；每项 sku、name 是非空且 trim 后非空的字符串，sku 唯一；unitPriceCents 是非负安全整数，quantity 是正安全整数；每项 price*quantity 及所有行累计都必须是安全整数。空数组合法，非法输入抛 Error。不修改输入。
2. setQuantity：先验证原购物车；sku 必须存在；新 quantity 是非负安全整数，0 删除该项。返回新的数组且所有返回项都复制，不能与输入共享对象；更新后也校验金额溢出。不要 trim 或改变原字符串值。
3. quote：先 validateCart；taxBasisPoints 是 0..10000 的整数；shippingCents 和 freeShippingThresholdCents 是非负安全整数；coupon 百分比 value 是 0..100 的整数，fixed value 为非负安全整数。每个金额均为整数分：subtotal=行总和；percent discount=floor(subtotal*value/100)，fixed discount=min(value,subtotal)；taxable=subtotal-discount；tax=四舍五入(taxable*taxBasisPoints/10000)，精确整数运算避免大数中间乘积溢出与浮点误差；shipping：空购物车为0，否则 taxable>=threshold 时为0，否则 shippingCents。返回指定 Quote 六个字段。total=taxable+tax+shipping；最终任一金额非安全整数抛 Error。不能修改输入或 options。
4. exportCsv：先 validateCart；表头 sku,name,unitPriceCents,quantity,lineTotalCents，行与结尾都 CRLF，空车仍有表头和 CRLF；字段含逗号、双引号、CR 或 LF 时加双引号，内部双引号双写。首个非空白字符为 =、+、- 或 @ 的 sku/name 字段在原内容前加单引号，防电子表格公式注入；数字字段不变。
5. index.ts 导出全部公共函数和类型。至少覆盖非法值、重复 sku、0 删除、对象隔离、大数精确计算、折扣/免邮边界、CSV 引号与公式保护。完成后简述实际改动、检查结果及未验证项。`;

const oracleSource = `import { test, expect } from "bun:test";
const { validateCart, setQuantity, quote, exportCsv } = await import(process.env.NEKO_EVAL_TARGET + "/src/index.ts");
const one = (price=101, qty=2, name="Apple", sku="A") => [{ sku, name, unitPriceCents: price, quantity: qty }];
const opts = (extra={}) => ({ taxBasisPoints:1000, shippingCents:50, freeShippingThresholdCents:1000, ...extra });
test("empty and basic", () => { expect(()=>validateCart([])).not.toThrow(); expect(quote(one(),opts())).toEqual({subtotalCents:202, discountCents:0,taxableCents:202,taxCents:20,shippingCents:50,totalCents:272}); });
test("bad sku/name", () => { for(const field of ["sku","name"]) for(const value of ["", " ",null,17]) expect(()=>validateCart([{...one()[0],[field]:value}])).toThrow(); });
test("bad numbers", () => { for(const [field,values] of [["quantity",[0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]],["unitPriceCents",[-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]]]) for(const value of values) expect(()=>validateCart([{...one()[0],[field]:value}])).toThrow(); });
test("duplicate and malformed", () => { expect(()=>validateCart([...one(),...one()])).toThrow(); for(const v of [null,{},[null]]) expect(()=>validateCart(v)).toThrow(); });
test("line overflow", () => expect(()=>validateCart(one(Number.MAX_SAFE_INTEGER,2))).toThrow());
test("sum overflow", () => expect(()=>validateCart([...one(Number.MAX_SAFE_INTEGER,1),...one(1,1,"B","B")])).toThrow());
test("immutable clones", () => { const a=[...one(),...one(7,1,"B","B")]; const b=setQuantity(a,"A",3); expect(b).not.toBe(a); expect(b[0]).not.toBe(a[0]); expect(b[1]).not.toBe(a[1]); expect(a[0].quantity).toBe(2); expect(b[0].quantity).toBe(3); });
test("delete and missing", () => { expect(setQuantity(one(),"A",0)).toEqual([]); expect(()=>setQuantity(one(),"missing",1)).toThrow(); });
test("update validation", () => { for(const v of [-1,1.5,NaN,Infinity]) expect(()=>setQuantity(one(),"A",v)).toThrow(); expect(()=>setQuantity(one(Number.MAX_SAFE_INTEGER,1),"A",2)).toThrow(); });
test("zero price", () => expect(quote(one(0),opts({freeShippingThresholdCents:0})).totalCents).toBe(0));
test("percent floor", () => expect(quote(one(101,1),opts({coupon:{kind:"percent",value:33},taxBasisPoints:0})).discountCents).toBe(33));
test("fixed clamped", () => { const q=quote(one(),opts({coupon:{kind:"fixed",value:999},freeShippingThresholdCents:1})); expect(q.taxableCents).toBe(0); expect(q.totalCents).toBe(50); });
test("free shipping is after discount", () => { expect(quote(one(1000,1),opts()).shippingCents).toBe(0); expect(quote(one(1000,1),opts({coupon:{kind:"fixed",value:1}})).shippingCents).toBe(50); });
test("empty shipping", () => expect(quote([],opts()).shippingCents).toBe(0));
test("tax half rounded up", () => expect(quote(one(5,1),opts({shippingCents:0})).taxCents).toBe(1));
test("large exact discount", () => { const p=Number.MAX_SAFE_INTEGER; const q=quote(one(p,1),opts({coupon:{kind:"percent",value:99},taxBasisPoints:0,shippingCents:0})); expect(q.discountCents).toBe(Number(BigInt(p)*99n/100n)); expect(q.totalCents).toBe(p-q.discountCents); });
test("large exact tax", () => { const p=4503599627370495; const q=quote(one(p,1),opts({taxBasisPoints:3333,shippingCents:0})); expect(q.taxCents).toBe(Number((BigInt(p)*3333n+5000n)/10000n)); });
test("total overflow", () => expect(()=>quote(one(Number.MAX_SAFE_INTEGER,1),opts({taxBasisPoints:10000,shippingCents:0}))).toThrow());
test("invalid options", () => { for(const patch of [{taxBasisPoints:-1},{taxBasisPoints:10001},{taxBasisPoints:.5},{shippingCents:-1},{freeShippingThresholdCents:.5},{coupon:{kind:"percent",value:101}},{coupon:{kind:"percent",value:1.5}},{coupon:{kind:"fixed",value:-1}},{coupon:{kind:"unknown",value:1}}]) expect(()=>quote(one(),opts(patch))).toThrow(); });
test("options immutable", () => { const a=one(); const o=opts({coupon:{kind:"fixed",value:1}}); const before=JSON.stringify({a,o}); quote(a,o); expect(JSON.stringify({a,o})).toBe(before); });
test("CSV empty", () => expect(exportCsv([])).toBe("sku,name,unitPriceCents,quantity,lineTotalCents\\r\\n"));
test("CSV quote escaping", () => expect(exportCsv(one(1,1,'a,"b"\\n'))).toBe('sku,name,unitPriceCents,quantity,lineTotalCents\\r\\nA,"a,""b""\\n",1,1,1\\r\\n'));
test("CSV formulas and raw whitespace", () => { for(const marker of ["=","+","-","@"]) expect(exportCsv(one(1,1,"  "+marker+"SUM(1)",marker+"x"))).toContain("'"+marker+"x,'  "+marker+"SUM(1),1,1,1"); });
test("CSV validates", () => expect(()=>exportCsv(one(1,0))).toThrow());
`;
const oracle = join(output, "oracle.test.ts"); await writeFile(oracle, oracleSource);
const summaries: unknown[] = [];
for (const selected of ["lead", "fusion"] as const) {
  if (process.env.NEKO_FUSION_EVAL_ONLY && process.env.NEKO_FUSION_EVAL_ONLY !== selected) continue;
  mode = selected;
  const cwd = join(output, selected), agentDir = join(output, selected + "-agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false }, commandShell: "pwsh" }));
  for (const [path, content] of Object.entries(fixtures)) { await mkdir(join(cwd, path, ".."), { recursive: true }); await writeFile(join(cwd, path), content); }
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
  runtime.registerProvider("neko-live-eval", { api: "openai-completions", baseUrl, models: [leadId, sideId].map((id) => ({
    id, name: id, reasoning: true, input: ["text"], contextWindow:131072, maxTokens:8192,
    cost: { input:0, output:0, cacheRead:0, cacheWrite:0 }, compat: { supportsDeveloperRole:false, supportsStore:false,
      supportsReasoningEffort:false, supportsUsageInStreaming:true, maxTokensField:"max_tokens",
      thinkingFormat: id === leadId ? "deepseek" : "qwen" },
  })) });
  await runtime.setRuntimeApiKey("neko-live-eval", key);
  const manager = SessionManager.create(cwd, join(output, selected + "-sessions"));
  const lead = runtime.getModel("neko-live-eval", leadId)!;
  const errors: string[] = []; const tools: { name: string; model?: string; error?: boolean }[] = [];
  const created = await createWorkflowSession({ cwd, agentDir, debugRoot: join(output,"debug"), modelRuntime:runtime, sessionManager:manager,
    initialMode:"agent", getPermission:()=>"auto", model:lead, thinkingLevel:"off",
    initialFusion:selected === "fusion" ? { orchestration, leadModelKey:`neko-live-eval/${leadId}`,sidekickModelKey:`neko-live-eval/${sideId}`, leadThinkingLevel:"off",sidekickThinkingLevel:"off",adaptiveRouting:true } : null,
    onChange:()=>{},onModeChange:()=>{},onError:(error)=>errors.push(error.replaceAll(key,"[redacted]")),
  });
  let requests = 0;
  created.session.subscribe((event) => {
    if(event.type === "message_start" && event.message.role === "assistant") {
      console.log(JSON.stringify({ event:"request", mode:selected, number:++requests, model:created.session.model?.id, role:created.workflow.context().fusionModelRole }));
      if(requests > 64) void created.session.abort();
    }
    if(event.type === "tool_execution_start") { tools.push({ name:event.toolName, model:created.session.model?.id }); console.log(JSON.stringify({event:"tool",mode:selected,name:event.toolName,model:created.session.model?.id})); }
    if(event.type === "tool_execution_end" && event.isError) console.log(JSON.stringify({event:"tool_error",mode:selected,name:event.toolName}));
  });
  const started = Date.now(); let timedOut = false;
  const timeout = setTimeout(()=> { timedOut = true; created.workflow.stop(); void created.session.abort(); }, 600000);
  try {
    await created.session.prompt(prompt);
    // Background completion can start another Lead turn and then another assignment.
    // Require the complete task/notification pipeline to be quiet before measuring.
    let quietSince = 0;
    while (!timedOut) {
      await created.workflow.whenSettled();
      const idle = created.session.isIdle && !created.workflow.state.hasRunningTasks && created.session.pendingMessageCount === 0;
      if (idle) { quietSince ||= Date.now(); if (Date.now() - quietSince >= 1000) break; }
      else quietSince = 0;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  catch(error) { errors.push(String(error).replaceAll(key,"[redacted]")); }
  finally { clearTimeout(timeout); }
  const elapsedMs = Date.now()-started;
  await Promise.all(captures);
  const proc = Bun.spawn(["bun","test",oracle], { cwd, env:{...process.env,NEKO_EVAL_TARGET:cwd,NEKO_FUSION_EVAL_KEY:undefined}, stdout:"pipe",stderr:"pipe" });
  const [stdout,stderr,exitCode] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  await writeFile(join(output,selected+"-validation.txt"),stdout+stderr);
  const ownTests = Bun.spawn(["bun", "test", "test"], { cwd, env: { ...process.env, NEKO_FUSION_EVAL_KEY: undefined }, stdout: "pipe", stderr: "pipe" });
  const [ownStdout, ownStderr, ownExitCode] = await Promise.all([new Response(ownTests.stdout).text(), new Response(ownTests.stderr).text(), ownTests.exited]);
  await writeFile(join(output, selected + "-own-tests.txt"), ownStdout + ownStderr);
  const relevant = calls.filter(call=>call.mode===selected);
  const byModel: Record<string,{calls:number;input:number;output:number;total:number;cacheRead:number;reasoning:number;missingUsage:number}> = {};
  for(const call of relevant) {
    const totals=byModel[call.requestedModel]??={calls:0,input:0,output:0,total:0,cacheRead:0,reasoning:0,missingUsage:0};totals.calls++;
    if(!call.usage) { totals.missingUsage++; continue; }
    const u=call.usage as any; totals.input+=u.prompt_tokens??0;totals.output+=u.completion_tokens??0;totals.total+=u.total_tokens??0;
    totals.cacheRead+=u.prompt_cache_hit_tokens??u.prompt_tokens_details?.cached_tokens??0;totals.reasoning+=u.completion_tokens_details?.reasoning_tokens??u.completion_thinking_tokens??0;
  }
  const assistants=manager.getBranch().filter(entry=>entry.type==="message"&&entry.message.role==="assistant");
  const last=assistants.at(-1);
  if (last?.type === "message" && last.message.role === "assistant" && last.message.stopReason === "error") {
    errors.push((last.message.errorMessage ?? "Assistant stream failed").replaceAll(key, "[redacted]"));
  }
  const snapshot = created.workflow.state.snapshot();
  const tasks = snapshot.tasks;
  const reviewed = selected === "lead" || (orchestration === "engine" ? snapshot.fusion?.status === "complete" : orchestration === "inline" ? tools.some(tool => tool.name === "fusion_review") :
    manager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "nekocode.task-result") &&
    tasks.some(task => task.kind === "worker" && task.status === "completed"));
  const completedNormally=last?.type === "message" && last.message.role === "assistant" && last.message.stopReason === "stop" &&
    (selected === "lead" || last.message.model === leadId) && reviewed &&
    !created.session.isStreaming && !created.workflow.state.hasRunningTasks && !errors.length && !timedOut;
  const result={mode:selected,orchestration:selected === "fusion" ? orchestration : undefined,timedOut,elapsedMs,pass:exitCode===0 && ownExitCode===0 && completedNormally,completedNormally,reviewed,ownTestsPass:ownExitCode===0,ownTestsExitCode:ownExitCode,validationPass:exitCode===0,validationExitCode:exitCode,sessionFile:manager.getSessionFile(),byModel,tools,errors,tasks,fusion:snapshot.fusion,
    lastMessage:assistants.at(-1),pricing:"unknown; registration zero prices are placeholders and are excluded from cost claims"};
  summaries.push(result);await writeFile(join(output,"results.json"),JSON.stringify({ endpoint,leadId,sideId,orchestration,prompt,thinking:"off for both",runs:summaries },null,2));
  await writeFile(join(output,"network.json"),JSON.stringify(calls,null,2));
  console.log(JSON.stringify({event:"run_complete",mode:selected,elapsedMs,pass:result.pass,completedNormally,validationPass:exitCode===0,byModel,errors}));
  created.workflow.dispose();created.session.dispose();await created.workflow.whenSettled();
}
globalThis.fetch=originalFetch;
console.log(JSON.stringify({event:"complete",path:output}));
