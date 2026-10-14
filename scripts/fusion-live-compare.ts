import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowSession } from "../src/main/workflow-runtime";
import { fusionDeliveryChecks, canRequestForDelivery } from "../src/main/fusion-delivery-check";
import { files as largeFiles, task as largeTask, verify as verifyLarge } from "./fusion-large-fixture";
const large = process.argv.includes("--large");
const reportPath = large ? "/tmp/fusion-large-comparison.json" : "/tmp/fusion-live-comparison.json";

const key = process.env.FUSION_SMOKE_API_KEY;
if (!key) throw new Error("FUSION_SMOKE_API_KEY is required");
const lead = "deepseek-v4.1-flash", side = "qwen3.8-flash", provider = "fusion-live-compare";
const source = `export type Item = { price: number; quantity: number; discount?: number };
export function subtotal(items: Item[]): number {
 return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
export function total(items: Item[], shipping = 0): number {
 return subtotal(items) - shipping;
}
`;
const prompt = "请实际修复工作区 cart.ts 并验收，不要只给建议。需求：subtotal 对每个商品使用 price*quantity*(1-discount)，discount 缺省为 0；total 在 subtotal 上加 shipping，shipping 缺省 0。保留函数签名和导出，不修改其他文件，不提交。先读实际代码再确定修改；修改后读取实际文件核对并最终说明已完成与未验证项。禁止 shell、测试、构建、浏览器及子代理。验收条件：subtotal([{price:100,quantity:2,discount:0.25}])=150；total 同商品 shipping=10 得160；缺省 discount 时原价；空数组 subtotal=0、total([],10)=10。无需询问，直接完成任务；验收以源码核对，验证限制应标为 skip。";
const sum = (records: any[]) => records.reduce((s, r) => ({ calls: s.calls + 1, input: s.input + r.input,
 output: s.output + r.output, cacheRead: s.cacheRead + r.cacheRead, cacheWrite: s.cacheWrite + r.cacheWrite,
 reasoning: s.reasoning + (r.reasoning ?? 0), totalTokens: s.totalTokens + r.totalTokens }),
 { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 });
async function run(fusion: boolean) {
 const cwd = await mkdtemp(join(tmpdir(), "fusion-compare-"));
 let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
 const requests: string[] = []; const errors: string[] = [];
 const started = Date.now();
 try {
  for (const [name, content] of Object.entries(large ? largeFiles : { "cart.ts": source })) await writeFile(join(cwd, name), content);
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
  runtime.registerProvider(provider, { baseUrl: "https://model.nekofun.top/v1", api: "openai-completions", apiKey: key,
   models: [lead, side].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) });
  await runtime.setRuntimeApiKey(provider, key!);
  const original = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
   const history = created?.session.messages ?? [];
   const reversed = [...history].reverse();
   const lastImplement = reversed.findIndex(m => m.role === "toolResult" && m.toolName === "fusion_implement" && !m.isError);
   const lastReview = reversed.findIndex(m => m.role === "toolResult" && m.toolName === "fusion_review" && !m.isError);
   const accepting = lastImplement >= 0 && lastReview >= 0 && lastReview < lastImplement;
   if (!canRequestForDelivery(requests.length, model.id, lead, fusion, large ? 32 : 20, 6, accepting))
    throw new Error(`Work request limit reached (${large ? 32 : 20}); six reserved requests are for Lead acceptance only`);
   requests.push(model.id); console.log(JSON.stringify({ mode: fusion ? "fusion" : "single", request: requests.length, model: model.id }));
   return original(model, context, options);
  };
  created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime,
   model: runtime.getAvailableSnapshot().find(m => m.provider === provider && m.id === lead), thinkingLevel: "off",
   sessionManager: SessionManager.inMemory(cwd), initialMode: "agent", getPermission: () => "auto",
   initialFusion: fusion ? { leadModelKey: `${provider}/${lead}`, sidekickModelKey: `${provider}/${side}`, leadThinkingLevel: "off", sidekickThinkingLevel: "off", adaptiveRouting: false } : null,
   onChange: () => undefined, onModeChange: () => undefined, onError: e => errors.push(e.replaceAll(key!, "[REDACTED]")) });
  const timer = setTimeout(() => { created?.workflow.stop(); void created?.session.abort(); }, large ? 600000 : 360000);
  try { await created.session.prompt(large ? largeTask : prompt); } finally { clearTimeout(timer); }
  const messages = created.session.messages;
  const records = messages.flatMap(m => m.role === "assistant" ? [{ model: m.model, stopReason: m.stopReason, ...m.usage }] : []);
  const toolCalls = messages.flatMap(m => m.role === "assistant" ? m.content.flatMap(p => p.type === "toolCall" ? [{ model: m.model, tool: p.name }] : []) : []);
  const file = large ? Object.fromEntries(await Promise.all(Object.keys(largeFiles).map(async name => [name, await readFile(join(cwd, name), "utf8")]))) : await readFile(join(cwd, "cart.ts"), "utf8");
  let checks: Record<string, boolean> = {};
  try {
   if (large) checks = await verifyLarge(cwd);
   else {
   const cart = await import(join(cwd, "cart.ts")); const items = [{ price: 100, quantity: 2, discount: 0.25 }];
   checks = { discount: cart.subtotal(items) === 150, shipping: cart.total(items, 10) === 160,
    defaultDiscount: cart.subtotal([{ price: 100, quantity: 2 }]) === 200, empty: cart.subtotal([]) === 0 && cart.total([], 10) === 10 };
   }
  } catch { checks = { loadable: false }; }
  const final = messages.filter(m => m.role === "assistant").at(-1);
  const delivery = fusionDeliveryChecks(messages, lead, fusion);
  const functionalPassed = Object.values(checks).every(Boolean);
  return { toolErrors: messages.flatMap(m => m.role === "toolResult" && m.isError ? [{ tool: m.toolName, text: m.content.filter(p => p.type === "text").map(p => p.text).join("\n") }] : []), mode: fusion ? "fusion" : "single", elapsedMs: Date.now() - started, requests,
   passed: functionalPassed && Object.values(delivery).every(Boolean), functionalPassed, delivery, checks, file, toolCalls, records,
   apiRequests: { total: requests.length, lead: requests.filter(m => m === lead).length, sidekick: requests.filter(m => m === side).length },
   accountingNote: "Usage records include local error messages with zero tokens; apiRequests counts actual issued requests.",
   usage: { total: sum(records), lead: sum(records.filter(r => r.model === lead)), sidekick: sum(records.filter(r => r.model === side)) }, errors,
   assistantErrors: records.filter(r => r.stopReason === "error" || r.stopReason === "aborted").length,
   final: final?.role === "assistant" ? final.content.filter(p => p.type === "text").map(p => p.text).join("\n") : "" };
 } finally { created?.workflow.dispose(); created?.session.dispose(); await rm(cwd, { recursive: true, force: true }); }
}
const single = await run(false);
await writeFile(reportPath, JSON.stringify({ task: large ? largeTask : prompt, single }, null, 2));
const fusion = await run(true);
const comparable = single.passed && fusion.passed;
const report = { task: large ? largeTask : prompt, single, fusion, comparable,
 leadTokenSavingPercent: comparable ? (single.usage.lead.totalTokens - fusion.usage.lead.totalTokens) / single.usage.lead.totalTokens * 100 : null,
 totalTokenSavingPercent: comparable ? (single.usage.total.totalTokens - fusion.usage.total.totalTokens) / single.usage.total.totalTokens * 100 : null,
 note: "One run per mode, single first. API-reported usage; shared server cache and stochastic outputs affect comparison. Reasoning is an output detail, not additional total. Prices are placeholders; no monetary conclusion." };
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
