import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/glass_page.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';

/// 「会话」首页：按项目分组的任务列表。
class SessionsPage extends StatelessWidget {
  const SessionsPage({
    super.key,
    required this.controller,
    required this.onCreate,
    required this.bottomBar,
  });

  final MobileController controller;
  final VoidCallback onCreate;
  final Widget Function(BuildContext, MiuixLayerBackdrop) bottomBar;

  MobileController get c => controller;

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

  String get subtitle {
    final name = c.desktop.name.isEmpty ? '电脑' : c.desktop.name;
    final link = c.desktop.mode == 'relay' ? '公网' : '局域网';
    return '$name · $link · ${c.online ? '在线' : '离线'}';
  }

  void open(Json task) {
    if (task['_acp'] == true) {
      unawaited(c.openAcp(task));
    } else {
      unawaited(c.openTask(task));
    }
  }

  @override
  Widget build(BuildContext context) {
    final rows = c.allTasks;
    final groups = <String, List<Json>>{};
    for (final row in rows) {
      groups.putIfAbsent(string(row['cwd']), () => []).add(row);
    }
    final running = rows.where((r) => r['running'] == true).length;
    return GlassPage(
      title: '会话',
      largeTitle: '会话',
      subtitle: subtitle,
      actions: [
        GlassAction(
          icon: MiuixIcons.os4.add,
          tooltip: '新建会话',
          onPressed: c.busy || !c.online ? null : onCreate,
        ),
      ],
      bottomBar: bottomBar,
      body: (context, scope) => MiuixPullToRefresh(
        isRefreshing: c.refreshing,
        onRefresh: () {
          c.histories.clear();
          unawaited(c.refresh());
        },
        contentPadding: EdgeInsets.only(top: scope.padding.top),
        topAppBarScrollBehavior: scope.behavior,
        child: ListView(
          controller: scope.controller,
          physics: const AlwaysScrollableScrollPhysics(),
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
            if (c.acpError != null)
              ErrorNotice('外部代理暂不可用：${c.acpError}。普通任务仍可使用。'),
            if (!c.online)
              _OfflineBanner(text: '电脑未连接，保持电脑唤醒并运行 NekoCode 后会自动重连。'),
            if (rows.isEmpty)
              EmptyState(
                icon: MiuixIcons.os4.messages,
                title: c.online ? '还没有会话' : '等待电脑连接',
                summary: c.online
                    ? '新建一个会话，让 NekoCode 在电脑上替你完成任务。'
                    : '连接成功后，电脑上的会话会同步显示在这里。',
                action: c.online
                    ? ActionButton(
                        '新建会话',
                        icon: Icons.add_rounded,
                        isPrimary: true,
                        onPressed: c.busy ? null : onCreate,
                      )
                    : null,
              )
            else ...[
              if (running > 0)
                Padding(
                  padding: const EdgeInsets.fromLTRB(28, 6, 28, 0),
                  child: Row(
                    children: [
                      MiuixInfiniteProgressIndicator(
                        color: context.mx.primary,
                        size: 14,
                        strokeWidth: 1.8,
                      ),
                      const SizedBox(width: 8),
                      MiuixText(
                        '$running 个任务运行中',
                        fontSize: 13,
                        color: context.mx.primary,
                        fontWeight: FontWeight.w500,
                      ),
                    ],
                  ),
                ),
              for (final group in groups.entries)
                NekoGroup(
                  title: projectName(group.key),
                  children: [
                    for (final task in group.value)
                      _SessionRow(
                        key: ValueKey('task:${task['id']}'),
                        task: task,
                        enabled: !c.busy && c.online,
                        selected:
                            c.taskId == task['id'] || c.acpId == task['id'],
                        onTap: () => open(task),
                      ),
                  ],
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _OfflineBanner extends StatelessWidget {
  const _OfflineBanner({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) {
    final tone = NekoTone.warning(context.isDark);
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: NekoGap.page,
        vertical: 6,
      ),
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: tone.withValues(alpha: .12),
          shape: NekoShape.squircle(16),
        ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              MiuixIcon(vector: MiuixIcons.os4.info, size: 18, tint: tone),
              const SizedBox(width: 10),
              Expanded(
                child: MiuixText(
                  text,
                  fontSize: 13.5,
                  height: 1.4,
                  color: tone,
                ),
              ),
            ],
          ),
        ),
      ),
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
    final c = context.mx;
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
    return MiuixBasicComponent(
      content: [
        MiuixText(
          title,
          fontSize: 16,
          fontWeight: FontWeight.w500,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        if (summary.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: MiuixText(
              summary,
              fontSize: 13.5,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              color: c.onSurfaceVariantSummary,
            ),
          ),
      ],
      enabled: enabled,
      onClick: onTap,
      insideMargin: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      startAction: Padding(
        padding: const EdgeInsets.only(right: 14),
        child: IconTile(
          icon: running ? MiuixIcons.os4.timer : MiuixIcons.os4.messages,
          color: c.primary,
          soft: !running,
          size: 40,
        ),
      ),
      endActions: [
        if (running)
          MiuixInfiniteProgressIndicator(
            color: c.primary,
            size: 16,
            strokeWidth: 2,
          )
        else
          MiuixText(
            SessionsPage.relativeTime(task['updatedAt']),
            fontSize: 12.5,
            color: c.onSurfaceVariantActions,
          ),
        const SizedBox(width: 4),
        MiuixIcon(
          vector: MiuixIcons.os4.chevronForward,
          size: 18,
          tint: c.onSurfaceVariantActions,
        ),
      ],
    );
  }
}
