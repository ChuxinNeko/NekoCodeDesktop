import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../ui/glass_page.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../connection/account_view.dart';
import '../mobile_controller.dart';

const _blue = Color(0xFF3482FF);
const _green = Color(0xFF2FBF71);
const _orange = Color(0xFFFF9A2E);
const _purple = Color(0xFF8B6CF0);

/// 设置页（首页右上角进入）：连接信息、传输方式、外观与断开。
class SettingsPage extends StatelessWidget {
  const SettingsPage({
    super.key,
    required this.controller,
    required this.toggleTheme,
  });

  final MobileController controller;
  final VoidCallback toggleTheme;

  MobileController get c => controller;

  Future<void> disconnect(BuildContext context) async {
    final ok = await showNekoConfirm(
      context,
      title: '断开并移除连接？',
      message: '将移除当前电脑的连接信息，需要重新扫码或登录后才能继续使用。',
      confirm: '断开连接',
      danger: true,
    );
    if (!ok) return;
    await c.disconnect();
    if (context.mounted && !c.paired) Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) =>
      ListenableBuilder(listenable: c, builder: (context, _) => _page(context));

  Widget _page(BuildContext context) {
    final dark = context.isDark;
    final relay = c.desktop.mode == 'relay';
    final tone = c.online
        ? NekoTone.success(context.isDark)
        : NekoTone.warning(context.isDark);
    final canRelay = !relay && c.desktop.relay.binding != null;
    final canLan = c.desktop.mode != 'lan' && c.desktop.lan != null;
    return GlassPage(
      title: '设置',
      largeTitle: '设置',
      navigationIcon: GlassAction(
        icon: MiuixIcons.os4.chevronBackward,
        tooltip: '返回',
        onPressed: () => Navigator.of(context).maybePop(),
      ),
      body: (context, scope) => ListView(
        controller: scope.controller,
        padding: EdgeInsets.only(
          top: scope.padding.top + 4,
          bottom: scope.padding.bottom + 24,
        ),
        children: [
          ErrorNotice(
            c.error,
            onDismiss: () {
              c.error = null;
              c.emit();
            },
          ),
          NekoGroup(
            title: '已连接的电脑',
            footer: relay
                ? '公网消息端到端加密；设备公钥由服务器分发，请只在可信服务上使用。'
                : '局域网 HTTP 连接仅适用于可信网络。电脑需保持唤醒并运行 NekoCode。',
            children: [
              MiuixBasicComponent(
                insideMargin: const EdgeInsets.all(16),
                startAction: Padding(
                  padding: const EdgeInsets.only(right: 14),
                  child: IconTile(
                    icon: MiuixIcons.os4.layers,
                    color: _blue,
                    size: 44,
                  ),
                ),
                content: [
                  MiuixText(
                    c.desktop.name.isEmpty ? '未命名设备' : c.desktop.name,
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                  ),
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: MiuixText(
                      c.desktop.endpoint,
                      fontSize: 13,
                      color: context.mx.onSurfaceVariantSummary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
                endActions: [
                  StatusDot(color: tone),
                  const SizedBox(width: 6),
                  MiuixText(
                    c.online ? '在线' : '离线',
                    fontSize: 13,
                    color: tone,
                    fontWeight: FontWeight.w500,
                  ),
                ],
              ),
              MiuixBasicComponent(
                title: '连接方式',
                insideMargin: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 14,
                ),
                endActions: [
                  MiuixText(
                    relay ? '公网连接' : '局域网',
                    fontSize: 15,
                    color: context.mx.onSurfaceVariantActions,
                  ),
                ],
              ),
              if (canRelay)
                MiuixArrowPreference(
                  title: '切换到公网连接',
                  onClick: c.busy ? null : () => c.switchTransport('relay'),
                ),
              if (canLan)
                MiuixArrowPreference(
                  title: '切换到局域网',
                  onClick: c.busy ? null : () => c.switchTransport('lan'),
                ),
            ],
          ),
          NekoGroup(
            title: '账号与公网',
            children: [
              MiuixArrowPreference(
                title: '公网连接管理',
                summary: c.desktop.account.signedIn
                    ? c.desktop.account.email
                    : '登录后可在外网访问电脑',
                startAction: Padding(
                  padding: const EdgeInsets.only(right: 14),
                  child: IconTile(
                    icon: MiuixIcons.os4.cloudFill,
                    color: _purple,
                  ),
                ),
                onClick: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => PublicConnectionPage(controller: c),
                  ),
                ),
              ),
            ],
          ),
          NekoGroup(
            title: '外观',
            children: [
              MiuixSwitchPreference(
                title: '深色模式',
                summary: '覆盖系统外观设置',
                value: dark,
                onChanged: (_) => toggleTheme(),
                startAction: Padding(
                  padding: const EdgeInsets.only(right: 14),
                  child: IconTile(icon: MiuixIcons.os4.theme, color: _orange),
                ),
              ),
            ],
          ),
          NekoGroup(
            title: '使用说明',
            children: [
              MiuixBasicComponent(
                title: '并行任务',
                summary:
                    '手机与桌面共享任务列表。新任务独立运行，切换会话不会停止后台任务；同一项目的任务共享文件，请避免同时修改相同文件。',
                startAction: Padding(
                  padding: const EdgeInsets.only(right: 14),
                  child: IconTile(icon: MiuixIcons.os4.tasks, color: _green),
                ),
                insideMargin: const EdgeInsets.all(16),
              ),
            ],
          ),
          const SizedBox(height: 20),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: NekoGap.page),
            child: ActionButton(
              '断开并移除当前连接',
              danger: true,
              expand: true,
              onPressed: c.busy ? null : () => disconnect(context),
            ),
          ),
        ],
      ),
    );
  }
}

/// 公网连接管理（登录、验证、设备选择）的独立页面。
class PublicConnectionPage extends StatelessWidget {
  const PublicConnectionPage({super.key, required this.controller});
  final MobileController controller;

  @override
  Widget build(BuildContext context) => GlassPage(
    title: '公网连接',
    navigationIcon: GlassAction(
      icon: MiuixIcons.os4.chevronBackward,
      tooltip: '返回',
      onPressed: () => Navigator.of(context).maybePop(),
    ),
    body: (context, scope) => ListenableBuilder(
      listenable: controller,
      builder: (context, _) => ListView(
        controller: scope.controller,
        padding: EdgeInsets.only(
          top: scope.padding.top + 8,
          bottom: scope.padding.bottom + 24,
          left: NekoGap.page,
          right: NekoGap.page,
        ),
        children: [PublicConnectionView(controller: controller)],
      ),
    ),
  );
}
