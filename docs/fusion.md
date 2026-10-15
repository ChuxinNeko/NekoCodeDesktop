# Fusion 使用指南

桌面端采用本地 `demo/fusion` 的共享 FusionEngine：**结构化计划 → 双通道并行执行 → Lead 整合**。参考提交为 `c4ecb1cc4b9d1ecdf4f3580991c8b5095fc8ece5`。七个核心、存储及 hook 文件逐字复制，来源和 SHA-256 记录在 `src/main/fusion/reference/provenance.json`。PI 适配层负责模型请求、工具、权限、持久化与桌面事件。

## 默认策略：delegate（Lead 指挥 + 审查，Sidekick 干活）

`FusionConfig.strategy` 默认为 `"delegate"`，目标是在尽量接近前沿 Lead 效果的同时把 Lead Token 降到最低。实测发现原 parallel 流程会多花 Lead：Lead 计划把主任务留给自己、Sidekick 的“事后复核”与 Main 并行空转，整合阶段 Lead 又带全部工具重读、重测一遍。delegate 流程：

1. **Brief（Lead，1 次无工具调用）**：`fusion_submit_brief` 返回路由（`delegate` / `lead`）、完整工作单（逐条编号复述所有需求与约束）、可选的 2–5 个有序工作项和仅供自己审查用的 `reviewFocus`。纯问答或两三步即可完成的小改动走 `lead`，由 Lead 单独完成。
2. **执行（Sidekick）**：同一个 Sidekick actor 依次完成各工作项（上下文与缓存持续复用），自测后输出固定格式报告（改动 / 验证命令与结果 / 假设与未决项）。
3. **审查（Lead，只读工具，默认 ≤5 步）**：Lead 拿到的是工作单、报告和 `FusionChangeTracker` 生成的**紧凑 diff**（写入前捕获原文），而不是重读整个工作区；通过 `fusion_submit_review` 给出 `accept`（附最终答复）、`revise`（具体问题清单，退回同一个 Sidekick 修复，最多 3 轮）或 `takeover`。
4. **接管（Lead，仅在必要时）**：只有 Sidekick 修同一问题失败或需要它不具备的推理时才接管，且从 diff 和问题清单继续，不从零开始。

所有受步数限制的阶段在最后一步会收到“预算用尽”提示并只保留提交工具（或无工具），保证一定产出报告或审查结论。Lead 的最终答复写回主会话；规划、执行、审查的用量都计入“本轮用量”。

`strategy: "parallel"` 保留下面描述的参考引擎流程。`strategy: "team"` 是 AI 团队模式，见 [team.md](team.md)。

## parallel 策略：Lead 与 Sidekick 如何分工

1. Lead 生成结构化计划：`complexity`、`mainTask`、最多六项 `sidekickTasks`。每项含任务和可选 profile。规划阶段只有输出计划的 `fusion_submit_plan` 工具，不执行项目操作。
2. 引擎通过 `Promise.all` 同时启动 Main 与 Sidekick 通道。Lead 执行主任务；Sidekick 顺序执行辅助任务。每项辅助任务创建新 worker 和 PI actor，工具循环独立，通道上下文由引擎保存。
3. 两条通道完成后，Lead 接收主结果及全部辅助结果，整合、拒绝错误建议并给出最终回复。Sidekick 失败形成警告并计入失败次数；Main 失败终止本轮。

两条通道均可执行当前权限允许的读写与命令工具，不强制所有修改交给 Sidekick。递归工作流派发与旧 `fusion_investigate` / `fusion_implement` / `fusion_review` 不参与共享引擎。执行和整合阶段各最多 20 个模型步骤，与参考 AiSdkAgentRunner 一致。

两条通道的上下文独立，不复制对方完整工具日志。Main 只在整合阶段接收辅助结果。新 worker 使用 Sidekick 通道的既有上下文，actor 不跨任务复用。用户消息在主会话只记录一次，规划失败也保留该消息。

## 自动路由何时切换

每条通道默认达到 24 条消息后独立压缩，再调用参考 AdaptiveRoutingPolicy。主通道候选只有 Lead；辅助通道候选为 Sidekick、Lead。辅助失败次数大于零时，压缩边界可将辅助通道升到 Lead；其余保持原选择。关闭自动路由时辅助候选只有 Sidekick。

不使用旧实现的自动请求重放或双模型故障转移。路由时机、失败累计和候选选择均由参考核心决定，不承诺固定 Token 节省比例。

## 配置、恢复与权限

面板设置两条通道模型、思考等级和自动路由。公开配置及历史保存配置恢复时统一采用 `orchestration: "engine"`；更改配置前停止运行。旧 `inline` / `parallel` 代码保留用于内部兼容测试，面板不提供切换入口。

配置还支持 `contextMessageLimit`、`budget` 和 `workerProfiles`。Profile 可限定说明、模型和工具集合，但不能越过当前权限。所有 actor 遵守当前模式、审批、工具守卫与文件日志；只读模式不能写入。两条通道共享工作区，参考架构未提供写入锁，计划应避免同时修改同一文件。命令执行不是操作系统级沙箱。

引擎通道快照存入 PI 会话树的 `nekocode.fusion.engine-session.v1` 条目。继续或重新加载会话时恢复两条通道及压缩计数；切换分支只读取当前分支快照。活动请求不会在应用重启后自动恢复。停止操作取消活动 actor，随后可开始新任务。

## 在哪里查看用量

工作流面板显示计划、Main/Sidekick 状态、worker 输出与工具活动。“本轮用量”记录主会话调用及隐藏的规划、辅助、压缩调用，Main 执行和整合不会重复统计。

参考 `maxTurns` 限制执行任务数，不是模型步骤数；`maxTokens` 观察执行与整合的累计用量，规划和压缩不计入预算；`timeoutMs` 限制本轮时间。这些语义原样保留。桌面用量与线上评测包含所有阶段实际报告的 Token，不能把引擎预算计数当作供应商总账。

## 代码与验证

- `src/main/fusion/reference/`：未改动的参考核心及来源记录。
- `src/main/fusion/pi-runner.ts`：参考四阶段 runner 的 PI 传输适配和提示词。
- `src/main/fusion/pi-stage-driver.ts`：工具循环、请求上下文、20 步上限与取消清理。
- `src/main/fusion/pi-session-store.ts`：PI 会话树持久化。
- `src/main/fusion/engine-runtime.ts`：桌面共享引擎客户端与单轮事件；按 `strategy` 选择 delegate 或 parallel。
- `src/main/fusion/delegate-engine.ts`：delegate 策略（brief → Sidekick 工作项 → Lead diff 审查 → 修复 / 接管）。
- `src/main/fusion/change-tracker.ts`：写入前捕获原文并生成紧凑 diff 供 Lead 审查。
- `src/shared/fusion-engine-state.ts`：参考网页 reducer，只调整导入路径。
- `test/main/fusion-reference/`：参考核心回归测试；桌面适配另有真实 PI SDK 的确定性集成测试。

复刻范围是共享编排核心及桌面适配；原项目 Vercel AI SDK、Modal 和 Browserbase 传输未搬入桌面端。参考通道消息为文本，图片保留在主会话记录中，但不传入共享引擎模型上下文。

真实模型对照见 [Fusion 对照评测](fusion-evaluation.md)。旧 `reports/fusion-live-2026-10-14/REPORT.md` 测试的是之前的 parallel 实现，不能证明本次共享引擎的效果。
