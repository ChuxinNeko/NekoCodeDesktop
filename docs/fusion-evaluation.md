# Fusion 对照评测

`scripts/fusion-live-eval.ts` 默认评测共享 `engine` 架构。第一轮 Lead 单模型，第二轮 Fusion；两轮使用相同任务、初始文件、思考设置与权限，并创建全新的项目及会话。

在当前进程设置 `NEKO_FUSION_EVAL_KEY` 后运行 `bun scripts/fusion-live-eval.ts`。密钥只用于内存授权，不写入报告。可设置 `NEKO_FUSION_EVAL_ENDPOINT`、`NEKO_FUSION_EVAL_LEAD`、`NEKO_FUSION_EVAL_SIDEKICK` 和 `NEKO_FUSION_EVAL_OUTPUT`。默认端点为 `https://model.nekofun.top/v1/chat/completions`，模型为 `deepseek-v4.1-flash` 和 `qwen3.8-flash`。运行会调用实际付费 API。

脚本捕获网关原始 SSE usage，按请求模型统计所有调用，包括规划、执行、整合与压缩。比较 Lead 的输入、输出、总 Token 和调用数，同时报告 Sidekick 及总 Token。缺失 usage 的中止请求必须标记，不能算作零；价格未知时不推断费用节省。

完成要求模型正常停止、引擎完成 Lead 整合、没有活动任务及错误，并通过模型补充的测试和独立 24 项验收。文件通过验收但整轮超时不能报告成功。

`results.json` 保存用量、完成状态、错误及引擎事件；`network.json` 保存上游用量；validation/own-tests 文件保存验收输出。旧 smoke/compare 脚本保留 inline 测试，旧 `reports/fusion-live-2026-10-14/REPORT.md` 属于 parallel 实现，均不能代表本次重构结果。

当前共享引擎两轮结果见 [2026-10-14 实测报告](../reports/fusion-engine-live-2026-10-14/REPORT.md)，架构与回归检查见 [重构验证](fusion-verification.md)。
