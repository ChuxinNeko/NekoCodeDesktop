import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../core/protocol.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'chat/chat_page.dart';
import 'connection/pairing_view.dart';
import 'mobile_controller.dart';
import 'sessions/sessions_page.dart';
import 'settings/settings_page.dart';

class MobileShell extends StatefulWidget {
  const MobileShell({
    super.key,
    required this.controller,
    required this.toggleTheme,
    required this.dark,
    this.initialize = true,
  });

  final MobileController controller;
  final VoidCallback toggleTheme;
  final bool dark, initialize;

  @override
  State<MobileShell> createState() => _MobileShellState();
}

class _MobileShellState extends State<MobileShell> with WidgetsBindingObserver {
  MobileController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (widget.initialize) unawaited(c.initialize());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    c.foreground = state == AppLifecycleState.resumed;
    if (c.foreground) unawaited(c.refresh());
  }

  Future<void> pickProject() async {
    final project = await showNekoSheet<String>(
      context,
      title: '选择项目',
      subtitle: '在所选项目中创建独立运行的会话',
      builder: (ctx) {
        final mx = ctx.mx;
        if (c.projects.isEmpty) {
          return const Padding(
            padding: EdgeInsets.fromLTRB(24, 8, 24, 32),
            child: MiuixText(
              '请先在电脑「设置 → 手机连接」中添加允许新建任务的项目。',
              fontSize: 14,
              height: 1.5,
            ),
          );
        }
        return ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
          children: [
            for (final p in c.projects)
              MiuixBasicComponent(
                insideMargin: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 12,
                ),
                startAction: Padding(
                  padding: const EdgeInsets.only(right: 14),
                  child: IconTile(
                    icon: MiuixIcons.os4.folderFill,
                    color: mx.primary,
                    size: 40,
                  ),
                ),
                content: [
                  MiuixText(
                    string(p['name']),
                    fontSize: 16,
                    fontWeight: FontWeight.w500,
                  ),
                  MiuixText(
                    string(p['path']),
                    fontSize: 12.5,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    color: mx.onSurfaceVariantSummary,
                  ),
                ],
                endActions: [
                  MiuixIcon(
                    vector: MiuixIcons.os4.chevronForward,
                    size: 18,
                    tint: mx.onSurfaceVariantActions,
                  ),
                ],
                onClick: () => Navigator.pop(ctx, p['id'] as String),
              ),
          ],
        );
      },
    );
    if (project != null) await c.newTask(project: project);
  }

  Future<void> create() async {
    if (c.projects.length != 1) {
      await pickProject();
    } else {
      await c.newTask(project: c.projects.first['id'] as String);
    }
  }

  /// 悬浮玻璃底部导航：会话 / 设置。
  Widget navBar(BuildContext context, MiuixLayerBackdrop backdrop) {
    return MiuixGlassNavigationBar(
      backdrop: backdrop,
      selectedIndex: c.view == 'settings' ? 1 : 0,
      onSelect: (i) => c.navigate(i == 0 ? 'tasks' : 'settings'),
      items: [
        MiuixGlassNavigationItem(
          icon: MiuixIcon(vector: MiuixIcons.os4.messages, size: 26),
          label: '会话',
        ),
        MiuixGlassNavigationItem(
          icon: MiuixIcon(vector: MiuixIcons.os4.settings, size: 26),
          label: '设置',
        ),
      ],
    );
  }

  Widget home() => c.view == 'settings'
      ? SettingsPage(
          key: const ValueKey('settings'),
          controller: c,
          dark: widget.dark,
          toggleTheme: widget.toggleTheme,
          bottomBar: navBar,
        )
      : SessionsPage(
          key: const ValueKey('sessions'),
          controller: c,
          onCreate: create,
          bottomBar: navBar,
        );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final Widget body;
      if (!c.ready) {
        body = Center(
          child: MiuixInfiniteProgressIndicator(
            color: context.mx.primary,
            size: 32,
            strokeWidth: 3,
          ),
        );
      } else if (!c.paired) {
        body = PairingView(controller: c);
      } else if (c.view == 'chat') {
        body = ChatPage(
          key: ValueKey('chat:${c.chatVersion}'),
          controller: c,
          onPickProject: pickProject,
          onBack: () => c.navigate('tasks'),
        );
      } else {
        body = home();
      }
      return PopScope(
        canPop: !c.paired || c.view == 'tasks',
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) c.navigate('tasks');
        },
        child: ColoredBox(color: context.mx.surface, child: body),
      );
    },
  );
}
