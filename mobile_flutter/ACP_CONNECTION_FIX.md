# ACP 未就绪导致 Flutter 误判断线

触发：主 `/api/state` 成功，`/api/acp/state` 返回 503「ACP 服务尚未就绪」。
原 Flutter 在同一个 Future.wait 中将 ACP 当成必需请求；503 丢弃主状态并设置 offline。
已修复：非 401 的 ACP 失败单独保存在 acpError，主任务与聊天继续工作；每轮重试 ACP，
恢复后清除警告。任务列表显示外部代理不可用但普通任务可用。401 仍走失效凭据流程。
回归测试先在旧实现失败，再修复通过。Flutter 全套 16 项通过、1 项服务测试默认跳过；
analyze 通过，Linux debug 构建通过，并已重新启动原生窗口。

桌面启动顺序另有确定的代码缺陷：
- src/main/index.ts:1952 先 registerIpc()，后 createWindow()。
- registerIpc 中 :1404 的 lanService?.setAcpProvider(acp) 此时被跳过。
- createWindow 中 :911 新建 LanService 时未设置 provider。
- 导致 LAN/relay ACP API 持续返回 503；桌面 WebUI 的 IPC ACP 路径不依赖此 provider。

桌面修复尚未应用：src/main/index.ts 由 root 所有，morax 写入得到 EACCES。
需由有权限者应用以下局部改动（不要覆盖用户其他修改）：

1. 在 let acpService 声明旁加：
   let acpProvider: (() => AcpService) | null = null;
2. registerIpc 的 lanService?.setAcpProvider(acp) 前加：
   acpProvider = acp;
3. new LanService(...) 后、restore/start relay 前加：
   if (acpProvider) lanService.setAcpProvider(acpProvider);

然后重新构建/重启桌面服务。客户端故障隔离无需该桌面修复即可使用普通任务。
尚未用用户正式公网账号联调，不能将自动化回归等同于正式公网验收。
