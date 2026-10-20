import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/glass_page.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';

/// 从左侧滑出的会话抽屉（首页 / 聊天页左上角按钮打开）。
Future<void> showSessionsDrawer(
  BuildContext context, {
  required MobileController controller,
  required VoidCallback onSettings,
}) {
  unawaited(controller.refresh());
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: '关闭会话列表',
    barrierColor: context.mx.windowDimming,
    transitionDuration: const Duration(milliseconds: 320),
    pageBuilder: (ctx, _, _) => SessionsDrawer(
      controller: controller,
      onSettings: () {
        Navigator.of(ctx).pop();
        onSettings();
      },
    ),
    transitionBuilder: (ctx, animation, _, child) {
      final curved = CurvedAnimation(
        parent: animation,
        curve: Curves.easeOutCubic,
        reverseCurve: Curves.easeInCubic,
      );
      return SlideTransition(
        position: Tween(
          begin: const Offset(-1, 0),
          end: Offset.zero,
        ).animate(curved),
        child: child,
      );
    },
  );
}

class SessionsDrawer extends StatelessWidget {
  const SessionsDrawer({
    super.key,
    required this.controller,
    required this.onSettings,
  });

  final MobileController controller;
  final VoidCallback onSettings;

  static String projectName(String cwd) =>
      cwd.split(RegExp(r'[/\\]')).where((s) => s.isNotEmpty).lastOrNull ??
      (cwd.isEmpty ? '未归类' : cwd);

  static String relativeTime(dynamic value) {
    if (value is! num) return '';
    final time = DateTime.fromMillisecondsSinceEpoch(value.toInt());
    final diff = DateTime.now().difference(time);
    if (diff.inMinutes < 1) return '刚刚';
    if (diff.inHours < 1) return '${diff.inMinutes} 分钟前';
    if (diff.inDays < 1) return '${diff.inHours} 小时前';
    if (diff.inDays < 2) return '昨天';
    if (diff.inDays < 7) return '${diff.inDays} 天前';
    return '${time.month}月${time.day}日';
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final width = (media.size.width * .86).clamp(0.0, 380.0);
    return Align(
      alignment: Alignment.centerLeft,
      child: SizedBox(
        width: width,
        height: double.infinity,
        child: Material(
          // 深色下抬高一档，和被遮罩的页面区分开。
          color: context.isDark
              ? context.mx.surfaceContainer
              : context.mx.surface,
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.horizontal(right: Radius.circular(28)),
          ),
          clipBehavior: Clip.antiAlias,
          child: ListenableBuilder(
            listenable: controller,
            builder: (context, _) => _body(context),
          ),
        ),
      ),
    );
  }

  void _close(BuildContext context) => Navigator.of(context).pop();

  void _open(BuildContext context, Json task) {
    _close(context);
    if (task['_acp'] == true) {
      unawaited(controller.openAcp(task));
    } else {
      unawaited(controller.openTask(task));
    }
  }

  void _create(BuildContext context) {
    _close(context);
    controller.navigate('tasks');
  }

  Widget _body(BuildContext context) {
    final c = controller;
    final mx = context.mx;
    final rows = c.allTasks;
    final groups = <String, List<Json>>{};
    for (final row in rows) {
      groups.putIfAbsent(string(row['cwd']), () => []).add(row);
    }
    final running = rows.where((r) => r['running'] == true).length;
    final tone = c.online
        ? NekoTone.success(context.isDark)
        : NekoTone.warning(context.isDark);
    final device = c.desktop.name.isEmpty ? '电脑' : c.desktop.name;
    final link = c.desktop.mode == 'relay' ? '公网' : '局域网';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: MediaQuery.removePadding(
            context: context,
            removeBottom: true,
            child: GlassPage(
              title: '会话',
              pinnedSmallTitle: true,
              floatingActions: true,
              navigationIcon: GlassAction(
                icon: MiuixIcons.os4.close,
                tooltip: '关闭',
                onPressed: () => _close(context),
              ),
              actions: [
                GlassAction(
                  icon: MiuixIcons.os4.add,
                  tooltip: '新建会话',
                  onPressed: () => _create(context),
                ),
              ],
              body: (context, scope) => rows.isEmpty
                  ? Padding(
                      padding: EdgeInsets.only(top: scope.padding.top),
                      child: EmptyState(
                        icon: MiuixIcons.os4.messages,
                        title: c.online ? '还没有会话' : '等待电脑连接',
                        summary: c.online
                            ? '在首页输入框描述任务，会话就会出现在这里。'
                            : '连接成功后，电脑上的会话会同步显示在这里。',
                      ),
                    )
                  : ListView(
                      controller: scope.controller,
                      padding: EdgeInsets.fromLTRB(
                        8,
                        scope.padding.top + 4,
                        8,
                        16,
                      ),
                      children: [
                        if (c.acpError != null)
                          ErrorNotice('外部代理暂不可用：${c.acpError}'),
                        if (running > 0)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(16, 4, 16, 2),
                            child: Row(
                              children: [
                                MiuixInfiniteProgressIndicator(
                                  color: mx.primary,
                                  size: 13,
                                  strokeWidth: 1.8,
                                ),
                                const SizedBox(width: 8),
                                MiuixText(
                                  '$running 个任务运行中',
                                  fontSize: 12.5,
                                  color: mx.primary,
                                  fontWeight: FontWeight.w500,
                                ),
                              ],
                            ),
                          ),
                        for (final group in groups.entries) ...[
                          Padding(
                            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
                            child: Row(
                              children: [
                                MiuixIcon(
                                  vector: MiuixIcons.os4.folder,
                                  size: 14,
                                  tint: mx.onSurfaceVariantSummary,
                                ),
                                const SizedBox(width: 6),
                                Expanded(
                                  child: MiuixText(
                                    projectName(group.key),
                                    fontSize: 12.5,
                                    fontWeight: FontWeight.w600,
                                    color: mx.onSurfaceVariantSummary,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          for (final task in group.value)
                            _SessionRow(
                              key: ValueKey('task:${task['id']}'),
                              task: task,
                              enabled: !c.busy && c.online,
                              selected:
                                  c.view == 'chat' &&
                                  (c.taskId == task['id'] ||
                                      c.acpId == task['id']),
                              onTap: () => _open(context, task),
                            ),
                        ],
                      ],
                    ),
            ),
          ),
        ),
        // 底部：设备状态 + 设置
        DecoratedBox(
          decoration: BoxDecoration(
            color: mx.surface,
            border: Border(top: BorderSide(color: mx.dividerLine)),
          ),
          child: SafeArea(
            top: false,
            right: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 10, 12, 10),
              child: Row(
                children: [
                  StatusDot(color: tone),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        MiuixText(
                          device,
                          fontSize: 14.5,
                          fontWeight: FontWeight.w600,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        MiuixText(
                          '$link · ${c.online ? '在线' : '离线'}',
                          fontSize: 12,
                          color: mx.onSurfaceVariantSummary,
                        ),
                      ],
                    ),
                  ),
                  MiuixGlassIconButton(
                    onPressed: onSettings,
                    tooltip: '设置',
                    semanticLabel: '设置',
                    child: MiuixIcon(vector: MiuixIcons.os4.settings, size: 22),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({
    super.key,
    required this.task,
    required this.onTap,
    required this.enabled,
    required this.selected,
  });
  final Json task;
  final VoidCallback onTap;
  final bool enabled, selected;

  @override
  Widget build(BuildContext context) {
    final mx = context.mx;
    final running = task['running'] == true;
    final title = task['titlePending'] == true
        ? '新会话'
        : string(task['title'], '新会话');
    final preview = string(task['preview']);
    final acp = task['_acp'] == true
        ? string(task['agentName'], string(task['agentId']))
        : '';
    final summary = [
      if (acp.isNotEmpty) acp,
      if (preview.isNotEmpty) preview,
    ].join(' · ');
    return MiuixPressable(
      onPressed: enabled ? onTap : null,
      semanticLabel: title,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 1),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        decoration: ShapeDecoration(
          color: selected
              ? mx.primary.withValues(alpha: .1)
              : Colors.transparent,
          shape: NekoShape.squircle(16),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  MiuixText(
                    title,
                    fontSize: 15,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                    color: selected ? mx.primary : null,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (summary.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: MiuixText(
                        summary,
                        fontSize: 12.5,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        color: mx.onSurfaceVariantSummary,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            if (running)
              MiuixInfiniteProgressIndicator(
                color: mx.primary,
                size: 14,
                strokeWidth: 2,
              )
            else
              MiuixText(
                SessionsDrawer.relativeTime(task['updatedAt']),
                fontSize: 11.5,
                color: mx.onSurfaceVariantActions,
              ),
          ],
        ),
      ),
    );
  }
}
