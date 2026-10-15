# Web 手机端 → Flutter 迁移验收清单

来源：`mobile/src/MobileApp.tsx`、`PairingView.tsx`、`AccountView.tsx`、
`PublicConnectionView.tsx`、`desktop-client.ts`、`lan-client.ts`、`relay-client.ts`，
以及共享 ChatView / AcpChatView / WorkflowPanel / ComposerPickers。

下面是目标清单，不表示全部已完成。“实现”不等于真实服务验收。

## 本轮验证

- `flutter analyze` 通过；Flutter 默认测试 15 项通过，1 项需真实 LAN 路由的测试默认跳过。
- 新增 Team 事件投影、扩展 widgets/status/working/远端等待、Fusion 自适应路由写入回归测试。
- `bun mobile_flutter/scripts/test-desktop-integration.ts` 单独启用该集成测试并通过：
  Dart HTTP 客户端直连生产 LanService，覆盖配对、鉴权、任务/消息/增量/配置/取消和 ACP 路由。
  Agent 与 ACP 执行器为测试适配器，不调用用户模型。
- 真实本地 WebSocket 覆盖 hello/ready、并发请求关联与双向加密 frame；
  Node WebCrypto 向量验证 P-256/AES-GCM 跨语言兼容和 AAD 篡改拒绝。
- 组件测试覆盖 390×844 明暗配对页、手动/账号切换、任务列表和聊天工作流。

## 尚未完成的对齐项

- 视觉尚非像素级 1:1，部分导航、选择器及列表仍使用 Material 控件；已使用 Miuix 主题、Scaffold、TopAppBar、按钮和输入框。
- 已补充工具 diff 增删行、Fast Context 报告及位置提取、完整原文和结构化结果；没有桌面文件打开能力，和旧手机端一致。
- 已补充 Fusion 计划/worker/思考/输出/工具事件详情、自适应路由开关，以及 Team 保存线程与实时事件投影。
- 已补充扩展文本块、状态、工作消息、编辑器插入；新增 `POST /api/tasks/:id/extension-answer`，Flutter 支持 select/confirm/input/editor/取消。LAN 与 relay 共用服务端验证，拒绝过期 ID、非法选项和超长输入；需使用本次更新后的桌面服务。
- 扩展对话框测试：Flutter 预填/多行/空文本/拒绝/取消/失败重试通过；`bun test test/main/lan-service.test.ts` 17 项通过，使用真实 ExtensionUiHost 验证队列推进、鉴权和 LAN/relay 回答。TypeScript 全量检查受缺失 `ai` 模块阻塞（TS2307），没有为此改依赖。
- 已补充探索器/worker 完整步骤与元数据、模型提供商分组；修正 ACP 历史标题/时间合并及 pristine 去重。
- Team 成员编辑不是旧手机端能力；旧 TeamPicker 的成员读取依赖桌面 preferences，失败使用默认 roster。Flutter 目前提示使用电脑配置，没有移植这份可能误导的默认 roster。
- Team 线程当前置于可展开工作流面板，而非消息间嵌入；保留成员、分配、模型、工具状态、错误和最终内容，但实时/已保存交界的完全一致性仍需更多真实事件联调。
- 未验证正式公网账号/邮件/中继、Android/iOS 构建、系统安全存储、相机权限及真机键盘/后台。
- 本机缺 Android SDK；iOS 构建必须在 macOS。当前不能宣称达到可发布或完整 1:1。

## 目标清单

- 连接：扫码 JSON 校验（类型、版本、过期、局域网地址）；手动配对；手机名；凭据恢复。
- 账号：登录、注册、邮箱验证、验证码重发、忘记密码、重置、旋转 refresh token 串行刷新、退出。
- 公网：设备列表、公钥哈希校验、P-256 ECDH、AES-GCM、双向 AAD、请求关联、超时、心跳、切换和重连。
- 任务：项目分组、运行状态、新任务项目选择、历史会话打开、1500ms 前台轮询。
- 本地聊天：增量快照、窗口分页、Markdown、思考、工具参数/结果、工具结果补全、消息发送/重试幂等、停止。
- 配置：模型、思考级别、执行权限、工作模式、Fusion/team 配置。
- 工作流：问题选项/自由文本/取消、todo、worker 进度/取消。
- ACP：启用的 agent、历史合并、热启动、新建/打开、消息/停止、动态配置、权限响应、命令。
- 设置：连接信息、LAN/relay 切换、明暗主题、退出登录回退、断开并移除连接。
- 平台：Android 相机和局域网 HTTP；iOS 相机/本地网络权限；前后台生命周期。

不添加旧 Web 手机端没有提供的桌面功能（内嵌终端、浏览器、检查点操作、图片附件）。
用户已明确无需样式 1:1；功能对齐继续按真实可用操作验收。真实 Android/iOS 链路需设备与服务联调，不能由静态检查代替。
