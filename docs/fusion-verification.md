# 共享引擎重构验证

参考架构为本地 `demo/fusion` 的共享 FusionEngine，源提交 `c4ecb1cc4b9d1ecdf4f3580991c8b5095fc8ece5`。2026-10-14，七个 vendored TypeScript 文件与原始文件及 provenance.json 的 SHA-256 全部一致。

## 确定性验证

- `bun run typecheck`：通过。
- `bun run build`：通过；仍有现有的大 chunk 提示。
- `bun test ./test/main/fusion-reference ./test/main/fusion-engine-integration.test.ts ./test/main/fusion-engine-boundaries.test.ts ./test/main/mcp-session-sync.test.ts`：45 通过、0 失败、170 断言。
- `bun test ./test`：完整应用回归 1299 通过、1 失败；这次运行包含新增边界测试中的前四项。随后新增的文件恢复、规划失败检查也在上述 45 项最终检查中通过。

完整回归唯一失败是已有 `FusionDetails.test.tsx` 的实际模型显示检查：汇总仍显示 configured-side，而断言期待该名称消失。此前用原始 HEAD 验证可重现，本次未改 UsagePanel.tsx。

参考核心覆盖计划、双通道并行、profiles、fresh worker id、synthesis、Sidekick 失败、独立压缩、路由、hooks 与预算。真实 PI SDK 适配测试覆盖同时启动及实际写入、上下文隔离、MCP 动态更新、20 步上限、双通道取消与再次运行、模型初始化失败清理、用户消息去重、规划失败保留输入、会话文件重载与分支回退。

取消验证发现并修复了父会话 abort 包装的递归调用，以及覆盖原生 isIdle 后造成的取消等待不释放。原生 isIdle 保留 PI 内部语义，整轮活动通过包装 isStreaming 与 runtime.running 表达。

## 实际模型验证

使用用户指定端点、Lead/Sidekick 模型，以相同任务按单 Lead、共享 FusionEngine 顺序完成两轮实测。结果见 [实测报告](../reports/fusion-engine-live-2026-10-14/REPORT.md)。Fusion 在 600 秒超时且未完成最终整合，不能证明同等质量下的有效 Lead Token 节省。

旧 `reports/fusion-live-2026-10-14/REPORT.md` 为之前 parallel 实现的历史数据，未覆盖本次架构。
