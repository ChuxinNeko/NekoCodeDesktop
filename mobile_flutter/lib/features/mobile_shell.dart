import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../core/protocol.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'chat/chat_page.dart';
import 'connection/pairing_view.dart';
import 'mobile_controller.dart';
import 'sessions/sessions_drawer.dart';
import 'settings/settings_page.dart';

class MobileShell extends StatefulWidget {
  const MobileShell({
    super.key,
    required this.controller,
    required this.toggleTheme,
    this.initialize = true,
  });

  final MobileController controller;
  final VoidCallback toggleTheme;
  final bool initialize;

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

  /// 首页项目选择：只切换草稿的项目，不离开欢迎页。
  Future<void> pickProject() async {
    final project = await showNekoSheet<String>(
      context,
      title: '选择项目',
      subtitle: '新会话将在所选项目中独立运行',
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
                  child: IconTile(icon: MiuixIcons.os4.folder),
                ),
                content: [
                  MiuixText(string(p['name']), fontSize: 16),
                  MiuixText(
                    string(p['path']),
                    fontSize: 12.5,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    color: mx.onSurfaceVariantSummary,
                  ),
                ],
                endActions: [
                  if (p['id'] == c.projectId)
                    MiuixIcon(
                      vector: MiuixIcons.os4.ok,
                      size: 20,
                      tint: mx.primary,
                    ),
                ],
                onClick: () => Navigator.pop(ctx, p['id'] as String),
              ),
          ],
        );
      },
    );
    if (project != null) await c.selectProject(project);
  }

  /// 首页代理选择：NekoCode 或已启用的外部代理。
  Future<void> pickAgent() async {
    final agent = await showNekoPicker<String>(
      context,
      title: '选择代理',
      selected: c.workspace,
      choices: [
        const NekoChoice('nekolocal', 'NekoCode'),
        for (final a in c.enabledAgents)
          NekoChoice(string(a['id']), string(a['name'], string(a['id']))),
      ],
    );
    if (agent != null) await c.selectWorkspace(agent);
  }

  void openSessions() => unawaited(
    showSessionsDrawer(context, controller: c, onSettings: openSettings),
  );

  void openSettings() => unawaited(
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            SettingsPage(controller: c, toggleTheme: widget.toggleTheme),
      ),
    ),
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
      } else {
        // 首页（欢迎页）与聊天页共用同一个 ChatPage：首页发送第一条消息后
        // 原地切换为聊天视图，输入框和消息流不会重建。
        body = ChatPage(
          key: ValueKey('chat:${c.chatVersion}'),
          controller: c,
          home: c.view != 'chat',
          onPickProject: pickProject,
          onPickAgent: pickAgent,
          onSessions: openSessions,
          onSettings: openSettings,
        );
      }
      return PopScope(
        canPop: !c.paired || c.view != 'chat',
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) c.navigate('tasks');
        },
        child: ColoredBox(color: context.mx.surface, child: body),
      );
    },
  );
}
