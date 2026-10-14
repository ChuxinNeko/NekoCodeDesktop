import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowSession } from "../src/main/workflow-runtime";

const key = process.env.FUSION_SMOKE_API_KEY;
if (!key) throw new Error("Set FUSION_SMOKE_API_KEY in the environment; credentials are never saved by this harness.");
const cwd = await mkdtemp(join(tmpdir(), "fusion-live-"));
const calls: { model: string; sessionId?: string; role?: string; tools: string[] }[] = [];
const errors: string[] = [];
let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
try {
 await writeFile(join(cwd, "price.ts"), "export function total(prices: number[]) { return prices.reduce((sum, price) => sum - price, 0); }\n");
 const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
 const lead = "deepseek-v4.1-flash", side = "qwen3.8-flash", provider = "fusion-live";
 runtime.registerProvider(provider, { baseUrl: process.env.FUSION_SMOKE_BASE_URL ?? "https://model.nekofun.top/v1", api: "openai-completions", apiKey: key,
  models: [lead, side].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) });
 await runtime.setRuntimeApiKey(provider, key);
 const original = runtime.streamSimple.bind(runtime);
 runtime.streamSimple = (model, context, options) => {
  if (calls.length >= 20) throw new Error("Live smoke reached its 20-request budget");
  const record = { model: model.id, sessionId: options?.sessionId, role: created?.workflow.context().fusionModelRole, tools: created?.session.getActiveToolNames() ?? [] };
  calls.push(record);
  console.log(JSON.stringify({ request: calls.length, model: record.model, role: record.role }));
  return original(model, context, { ...options, onPayload: async (payload, target) => {
   const next = await options?.onPayload?.(payload, target) ?? payload;
   const request = next as { tools?: unknown[] };
   await writeFile("/tmp/fusion-live-tool-schemas.json", JSON.stringify(request.tools, null, 2));
   return next;
  } });
 };
 created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime,
  sessionManager: SessionManager.inMemory(cwd), initialMode: "agent", getPermission: () => "auto",
  initialFusion: { orchestration: "inline", leadModelKey: `${provider}/${lead}`, sidekickModelKey: `${provider}/${side}`, leadThinkingLevel: "off", sidekickThinkingLevel: "off", adaptiveRouting: false },
  onChange: () => undefined, onModeChange: () => undefined, onError: error => errors.push(error.replaceAll(key, "[REDACTED]")) });
 const deadline = setTimeout(() => { created?.workflow.stop(); void created?.session.abort(); }, 360_000);
 try {
  await created.session.prompt("这是 Fusion 真实链路实测。在同一主会话中交替工作，不创建子代理。Lead 先用 fusion_investigate 让 Sidekick 读取 price.ts 并返回函数实际行为和位置；Lead 根据证据决定修复方案，再用 fusion_implement 让 Sidekick 仅修复 price.ts，使 total([2,3]) 等于 5、total([]) 等于 0，最后 Lead 读取实际文件验收并回复。不要运行 shell、测试、构建或浏览器，不提交。此次验证方式为源码核对，verification=skip，明确注明未运行测试。不要重复调查。已知文件就是工作区根目录的 price.ts，Sidekick 直接 read(path=price.ts) 后立即返回报告，不需要 find/ls/stat/grep。");
 } finally { clearTimeout(deadline); }
 const messages = created.session.messages;
 const tools = messages.flatMap(m => m.role === "assistant" ? m.content.flatMap(p => p.type === "toolCall" ? [{ model: m.model, name: p.name, arguments: p.arguments }] : []) : []);
 const output = await readFile(join(cwd, "price.ts"), "utf8");
 const total = (await import(join(cwd, "price.ts"))).total as (values: number[]) => number;
 const checks = { expectedResults: total([2, 3]) === 5 && total([]) === 0, sameSession: new Set(calls.map(c => c.sessionId)).size === 1 && !!calls[0]?.sessionId,
  noBackgroundTasks: created.workflow.state.snapshot().tasks.length === 0,
  investigation: tools.some(t => t.name === "fusion_investigate"), implementation: tools.some(t => t.name === "fusion_implement"),
  leadFinal: messages.filter(m => m.role === "assistant").at(-1)?.model === lead,
  investigationReadOnly: calls.filter(c => c.role === "sidekick" && c.tools.includes("read") && !c.tools.includes("write")).length > 0 };
 const final = messages.filter(m => m.role === "assistant").at(-1);
 const usageRecords = messages.flatMap(m => m.role === "assistant" ? [{ model: m.model, stopReason: m.stopReason, ...m.usage }] : []);
 const sumUsage = (records: typeof usageRecords) => records.reduce((sum, usage) => ({
  calls: sum.calls + 1, input: sum.input + usage.input, output: sum.output + usage.output,
  cacheRead: sum.cacheRead + usage.cacheRead, cacheWrite: sum.cacheWrite + usage.cacheWrite, totalTokens: sum.totalTokens + usage.totalTokens,
 }), { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
 const usage = { source: "API-reported SDK usage; configured cost=0 is a placeholder, not a real price", records: usageRecords,
  lead: sumUsage(usageRecords.filter(r => r.model === lead)), sidekick: sumUsage(usageRecords.filter(r => r.model === side)), total: sumUsage(usageRecords) };
 console.log(JSON.stringify({ checks, calls, tools, output, errors, usage,
  toolErrors: messages.flatMap(m => m.role === "toolResult" && m.isError ? [{ name: m.toolName, text: m.content.filter(p => p.type === "text").map(p => p.text).join("\n") }] : []),
  assistantErrors: messages.flatMap(m => m.role === "assistant" && m.errorMessage ? [m.errorMessage.replaceAll(key, "[REDACTED]")] : []),
  final: final?.role === "assistant" ? final.content.filter(p => p.type === "text").map(p => p.text).join("\n") : undefined }, null, 2));
 if (Object.values(checks).some(value => !value)) process.exitCode = 1;
} finally { created?.workflow.dispose(); created?.session.dispose(); await rm(cwd, { recursive: true, force: true }); }
