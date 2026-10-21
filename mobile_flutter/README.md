# NekoCode Mobile · Flutter

独立的原生移动端工程，面向 Android 和 iOS，不使用 WebView/React/Capacitor。
旧版 `../mobile/` 保持不变。现已接入真实通信和交互：扫码/手动配对、账号登录/注册/
验证/重置、设备选择、加密公网中继、任务列表/创建/发送/停止、增量历史、工具输出分页、
工作流问答/todo/worker、ACP 历史/配置/权限及主题切换。

本轮继续补齐 Fusion inspector/自适应路由、Team 线程与工具状态、扩展 UI 文本/状态/
编辑器插入、探索器/worker 详情、diff 和 Fast Context 报告及提供商分组。
扩展对话框已支持选择、确认/拒绝、输入、多行编辑和取消，通过新增 extension-answer
接口同时支持 LAN/relay；需同步更新并重启桌面服务，旧桌面版本没有该接口。
**尚不能宣称完成全部功能验收**：未真机联调，Team 实时/保存交界需进一步真实事件验证。
样式不要求与旧版一致；详细能力边界及验证记录见 `MIGRATION.md`。

## 版本

- Flutter **3.47.7 stable**（初始化时国内发布索引中的最新稳定版）
- Dart **3.13.5**（由 Flutter SDK 自带）
- `flutter_miuix: ^1.3.0`，实际解析版本由 `pubspec.lock` 固定
- `.fvmrc` 固定 Flutter 版本；安装了 FVM 的机器可运行 `fvm install`，然后使用 `fvm flutter ...`

不要把 SDK 放进仓库。当前服务器安装位置：
`~/.local/share/nekocode/flutter-3.47.7`。
SDK 来自 `https://storage.flutter-io.cn/flutter_infra_release/releases/stable/linux/flutter_linux_3.47.7-stable.tar.xz`，
已对照发布索引校验 SHA-256：
`af7455f540df951184c7953fbe3cf884766e7541dacf8571f9f582db03dd6230`。

## 中国大陆环境

```sh
cd mobile_flutter
. scripts/env.sh
flutter --version
flutter pub get
flutter analyze
flutter test
flutter devices
flutter run -d <设备ID>
```

`env.sh` 仅作用于当前 shell，不修改全局环境，默认使用：

```sh
export FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn
export PUB_HOSTED_URL=https://pub.flutter-io.cn
```

若已有显式环境变量配置，脚本保留原值；若当前服务器 SDK 不存在，使用 PATH
中的 Flutter。镜像同步存在延迟时，应先核对包版本和发布索引，不要随意切换未知 Git 镜像。

Windows PowerShell 请设置上述两个环境变量（`$env:变量名 = '值'`），并自行安装对应平台 SDK。

## Linux 桌面运行与验收

已添加 `linux/` 原生 runner，可在 morax 当前 X11 桌面运行：

```sh
cd mobile_flutter
. scripts/env.sh
. scripts/linux-env.sh  # 当前服务器用户目录的构建依赖；标准系统环境不需要
flutter run -d linux

# 在真实 GTK/Flutter 窗口内执行，不是无头 widget test
flutter test integration_test/linux_desktop_test.dart -d linux
```

已实际通过 Linux 原生构建和 3 项桌面集成测试：扩展选择/拒绝/取消/编辑提交、
失败保留草稿重试，以及应用启动、手动配置切换和系统安全存储读写/删除。
测试存储只使用唯一的临时 key，不覆盖登录/配对凭据。
本机缺少的编译与开发包从现有华为云 Ubuntu 源下载，解包在
`~/.local/share/nekocode/linux-toolchain/`，没有使用 sudo 或升级系统包。
Linux 不能验证手机相机、移动系统权限或软键盘。

## 平台构建

- Android：安装 Android SDK 和兼容的 JDK，运行 `flutter doctor -v`，按提示接受许可证；
  再执行 `flutter build apk --debug`。正式签名应另行配置，不将密钥提交到仓库。
- iOS：必须在 macOS 上安装 Xcode 和所需构建工具，配置签名后构建。
- Flutter/Pub 镜像不代理 Maven 或 Gradle。Android 依赖下载遇到网络问题时，需单独配置可信镜像。
- 当前使用独立应用标识：Android 为 `com.nekocode.nekocode_mobile`，iOS 为
  `com.nekocode.nekocodeMobile`，可与旧版 `com.nekocode.mobile` 共存；正式替换旧版前
  需确认应用标识、签名及数据迁移策略。

## 代码结构

```text
lib/
  main.dart                       # 启动入口
  app.dart                        # Miuix 主题、持久化明暗设置
  core/                           # HTTP/账号/安全存储/加密中继/增量协议
  features/mobile_controller.dart  # 前台轮询、会话和连接状态转换
  features/mobile_shell.dart       # 任务列表、项目选择、设置
  features/connection/             # 扫码配对、账号与公网设备
  features/chat/                   # 聊天、配置、工具、工作流
android/                          # Android 原生工程
ios/                              # iOS 原生工程
test/widget_test.dart             # 明暗主题、窄屏布局及按钮交互测试
scripts/env.sh                    # 当前 shell 的国内镜像和 SDK 环境
```

## 验证

```sh
# Flutter 分析、单元/组件、本地 WebSocket 测试
flutter analyze
flutter test

# 从仓库根目录运行：Dart 客户端直连真实生产 LanService 路由
bun mobile_flutter/scripts/test-desktop-integration.ts
```

集成测试使用临时目录与随机端口，复用真实鉴权、路由、幂等、增量实现；Agent/ACP
执行器使用确定性测试适配器，不调用真实模型。测试退出会关闭服务并清理临时目录。
普通 `flutter test` 跳过这项需服务的测试，集成脚本单独启用。

加密另有 Node WebCrypto 生成的 P-256/AES-GCM 兼容向量以及真实本地 WebSocket
双向加密帧测试。测试向量仅是随机测试密钥，不是生产身份。

尚未验证真实账号邮件、正式中继部署、相机扫码、系统安全存储、Android/iOS 构建及
真机键盘/后台行为。当前服务器缺少 Android SDK，iOS 需 macOS。Android/iOS 为兼容
现有局域网 HTTP 配置了明文访问许可；应用层配对目标仍只允许字面本地地址。

客户端身份、登录凭据和配对 token 使用系统安全存储。Flutter 采用独立应用标识，
不会自动读取旧 Capacitor 应用的数据，需要重新登录/配对。原始示例 home_page.dart
已不再作为应用入口使用。

不把桌面端 Agent 执行核心搬到手机，也不在新客户端中嵌入旧 React 页面。

## 消息工作流与文件差异

消息按桌面端同样的阶段规则组织为「工作流 → 二级阶段标题 → 原始详情」。阶段标题
默认收起，点击后显示完整思考、说明和工具调用；工具仍可单独展开参数与输出。

编辑文件时，输入框上方显示文件变更胶囊，汇总文件数、新增和删除行数；结束后胶囊
随对应轮次留在消息记录中。点击胶囊可打开文件列表，再点击文件查看只读、分页 diff，
支持二进制文件提示、加载更多和失败重试。远程快照携带完整当前轮次的统计，避免长
会话裁剪消息后漏计文件。

需要重新构建并重启桌面端，以启用 `/api/tasks/:id/checkpoint-diff`。旧桌面端仍可
显示本地统计，查看详情时会提示升级。LAN 与公网连接共用桌面服务接口；`server/`
仅转发端到端加密数据，不需要新增明文 diff API，也无需为此变更公网后端。
