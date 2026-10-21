import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../ui/glass_page.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../connection/account_view.dart';
import '../mobile_controller.dart';

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

  static const _taskHelp =
      '手机与桌面共享任务列表。新任务独立运行，切换会话不会停止后台任务；同一项目的任务共享文件，请避免同时修改相同文件。';
  String get _transport => c.desktop.mode == 'relay'
      ? '公网连接'
      : c.desktop.mode == 'lan'
      ? '局域网'
      : '未连接';
  String get _security => c.desktop.mode == 'relay'
      ? '公网消息端到端加密；设备公钥由服务器分发，请只在可信服务上使用。'
      : '局域网 HTTP 连接仅适用于可信网络。电脑需保持唤醒并运行 NekoCode。';

  void _info(BuildContext context, String title, String message) {
    showNekoSheet<void>(
      context,
      title: title,
      builder: (ctx) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 28),
        child: SelectableText(
          message,
          style: TextStyle(
            fontSize: 15,
            height: 1.6,
            color: ctx.mx.onSurfaceVariantSummary,
          ),
        ),
      ),
    );
  }

  void _appearance(BuildContext context) {
    showNekoSheet<void>(
      context,
      title: '外观',
      builder: (ctx) => SingleChildScrollView(
        padding: const EdgeInsets.only(bottom: 20),
        child: MiuixSwitchPreference(
          title: '深色模式',
          summary: '覆盖系统外观设置',
          value: ctx.isDark,
          onChanged: (_) => toggleTheme(),
        ),
      ),
    );
  }

  void _connection(BuildContext context) {
    showNekoSheet<void>(
      context,
      title: '连接方式',
      builder: (ctx) => ListenableBuilder(
        listenable: c,
        builder: (ctx, _) => SingleChildScrollView(
          padding: const EdgeInsets.only(bottom: 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ErrorNotice(c.error),
              MiuixBasicComponent(title: '当前连接', summary: _transport),
              if (c.desktop.mode != 'relay' && c.desktop.relay.binding != null)
                MiuixArrowPreference(
                  title: '切换到公网连接',
                  summary: '通过已绑定的公网设备连接',
                  enabled: !c.busy,
                  onClick: () async {
                    await c.switchTransport('relay');
                    if (ctx.mounted && c.error == null) Navigator.pop(ctx);
                  },
                ),
              if (c.desktop.mode != 'lan' && c.desktop.lan != null)
                MiuixArrowPreference(
                  title: '切换到局域网',
                  summary: '手机与电脑需处于同一可信网络',
                  enabled: !c.busy,
                  onClick: () async {
                    await c.switchTransport('lan');
                    if (ctx.mounted && c.error == null) Navigator.pop(ctx);
                  },
                ),
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 24,
                  vertical: 8,
                ),
                child: MiuixText(
                  '局域网需先扫码配对；公网连接需登录账号并绑定电脑。',
                  fontSize: 14,
                  color: ctx.mx.onSurfaceVariantSummary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _page(BuildContext context) {
    final account = c.desktop.account;
    // Miuix 1.3 的顶栏大标题使用未继承字体/缩放的 TextPainter 高度并裁剪。
    // 在滚动内容里自然布局标题，中文回退字体和系统大字体都不受固定行高限制。
    return GlassPage(
      title: '',
      pinnedSmallTitle: true,
      navigationIcon: Tooltip(
        message: '返回',
        child: MiuixIconButton(
          minWidth: 48,
          minHeight: 48,
          onPressed: () => Navigator.of(context).maybePop(),
          child: MiuixIcon(
            vector: MiuixIcons.os4.back,
            size: 26,
            tint: context.mx.onSurface,
          ),
        ),
      ),
      body: (context, scope) => ListView(
        controller: scope.controller,
        padding: EdgeInsets.only(
          top: scope.padding.top + 8,
          bottom: scope.padding.bottom + 32,
        ),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 8, 28, 24),
            child: Semantics(
              header: true,
              child: Text(
                '设置',
                key: const ValueKey('settings-large-title'),
                softWrap: true,
                style: context.mxText.title1.copyWith(
                  color: context.mx.onSurface,
                  fontWeight: FontWeight.w600,
                  height: 1.3,
                ),
              ),
            ),
          ),
          ErrorNotice(
            c.error,
            onDismiss: () {
              c.error = null;
              c.emit();
            },
          ),
          _SettingsGroup(
            title: '账号',
            children: [
              _SettingsMenu(
                icon: MiuixIcons.os4.contactsCircle,
                title: account.signedIn ? '账号管理' : '登录账号',
                summary: account.signedIn
                    ? account.email ?? '管理账号与公网设备'
                    : '登录后可在外网访问电脑',
                onClick: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => PublicConnectionPage(controller: c),
                  ),
                ),
              ),
            ],
          ),
          _SettingsGroup(
            title: '电脑与连接',
            children: [
              _SettingsMenu(
                icon: MiuixIcons.os4.layers,
                title: c.paired
                    ? (c.desktop.name.isEmpty ? '未命名设备' : c.desktop.name)
                    : '未连接电脑',
                summary: '设备信息与连接地址',
                value: c.online ? '在线' : '离线',
                onClick: () => _info(
                  context,
                  '设备信息',
                  '${c.desktop.name.isEmpty ? '未命名设备' : c.desktop.name}\n${c.online ? '在线' : '离线'} · $_transport\n${c.paired ? c.desktop.endpoint : '尚未配对电脑'}\n\n$_security',
                ),
              ),
              _SettingsMenu(
                icon: MiuixIcons.os4.link,
                title: '连接方式',
                summary: '局域网与公网连接管理',
                value: _transport,
                onClick: () => _connection(context),
              ),
            ],
          ),
          _SettingsGroup(
            title: '应用',
            children: [
              _SettingsMenu(
                icon: MiuixIcons.os4.theme,
                title: '外观',
                summary: '主题与深色模式',
                value: context.isDark ? '深色' : '浅色',
                onClick: () => _appearance(context),
              ),
            ],
          ),
          _SettingsGroup(
            title: '帮助与说明',
            children: [
              _SettingsMenu(
                icon: MiuixIcons.os4.tasks,
                title: '并行任务',
                summary: '多任务运行与共享文件说明',
                onClick: () => _info(context, '并行任务', _taskHelp),
              ),
              _SettingsMenu(
                icon: MiuixIcons.os4.lock,
                title: '连接安全',
                summary: '网络要求与加密说明',
                onClick: () => _info(context, '连接安全', _security),
              ),
            ],
          ),
          if (c.paired) ...[
            const SizedBox(height: 24),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: ActionButton(
                '断开并移除当前连接',
                danger: true,
                expand: true,
                onPressed: c.busy ? null : () => disconnect(context),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _SettingsGroup extends StatelessWidget {
  const _SettingsGroup({required this.title, required this.children});
  final String title;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 24, 16, 10),
          child: MiuixText(
            title,
            fontSize: 14,
            color: context.mx.onSurfaceVariantSummary,
          ),
        ),
        ClipPath(
          clipper: ShapeBorderClipper(shape: NekoShape.squircle(24)),
          child: MiuixCard(
            cornerRadius: 24,
            insideMargin: const EdgeInsets.symmetric(vertical: 6),
            child: Column(children: children),
          ),
        ),
      ],
    ),
  );
}

class _SettingsMenu extends StatelessWidget {
  const _SettingsMenu({
    required this.icon,
    required this.title,
    required this.summary,
    required this.onClick,
    this.value,
  });
  final MiuixVectorIcon icon;
  final String title, summary;
  final String? value;
  final VoidCallback onClick;
  @override
  Widget build(BuildContext context) => MiuixArrowPreference(
    title: title,
    summary: summary,
    insideMargin: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
    startAction: Padding(
      padding: const EdgeInsets.only(right: 16),
      child: Container(
        width: 36,
        height: 36,
        alignment: Alignment.center,
        decoration: ShapeDecoration(
          color: context.mx.onSurface.withValues(alpha: .055),
          shape: NekoShape.squircle(11),
        ),
        child: MiuixIcon(vector: icon, size: 23, tint: context.mx.onSurface),
      ),
    ),
    endActions: value == null
        ? null
        : [
            MiuixText(
              value!,
              fontSize: 14,
              color: context.mx.onSurfaceVariantSummary,
            ),
          ],
    onClick: onClick,
  );
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
