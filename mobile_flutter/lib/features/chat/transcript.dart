import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_miuix/miuix.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';
import 'tool_presentation.dart';
import 'tool_result.dart';
import 'transcript_rows.dart';
import 'workflow_style.dart';
import 'working_orb.dart';
import 'workflow_tool_glyph.dart';

/// Markdown 样式：跟随 Miuix 色板，代码块使用中性灰底。
MarkdownStyleSheet nekoMarkdown(BuildContext context, {double size = 15.5}) {
  final c = context.mx;
  final dark = context.isDark;
  final base = TextStyle(fontSize: size, height: 1.6, color: c.onSurface);
  final heading = base.copyWith(fontWeight: FontWeight.w700, height: 1.4);
  return MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
    p: base,
    pPadding: EdgeInsets.zero,
    h1: heading.copyWith(fontSize: size + 5),
    h2: heading.copyWith(fontSize: size + 3),
    h3: heading.copyWith(fontSize: size + 1),
    h4: heading,
    strong: base.copyWith(fontWeight: FontWeight.w700),
    em: base.copyWith(fontStyle: FontStyle.italic),
    a: base.copyWith(color: c.primary),
    listBullet: base,
    listIndent: 22,
    blockSpacing: 12,
    code: TextStyle(
      fontFamily: 'monospace',
      fontSize: size - 2.5,
      color: c.onSurface,
      backgroundColor: NekoTone.codeBackground(dark),
    ),
    codeblockPadding: const EdgeInsets.all(14),
    codeblockDecoration: ShapeDecoration(
      color: NekoTone.codeBackground(dark),
      shape: NekoShape.squircle(16),
    ),
    blockquotePadding: const EdgeInsets.fromLTRB(14, 4, 4, 4),
    blockquoteDecoration: BoxDecoration(
      border: Border(
        left: BorderSide(color: c.primary.withValues(alpha: .6), width: 3),
      ),
    ),
    horizontalRuleDecoration: BoxDecoration(
      border: Border(top: BorderSide(color: c.dividerLine, width: 1)),
    ),
    tableBorder: TableBorder.all(color: c.dividerLine, width: .6),
    tableHead: base.copyWith(fontWeight: FontWeight.w700),
    tableBody: base,
    tableCellsPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
  );
}

Future<void> _openLink(String? href) async {
  final uri = Uri.tryParse(href ?? '');
  if (uri != null && ['https', 'http'].contains(uri.scheme)) {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}

/// 一条用户 / 助手消息。
class MessageCell extends StatelessWidget {
  const MessageCell({super.key, required this.cell, required this.controller});
  final Json cell;
  final MobileController controller;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    final text = string(cell['text']);
    if (cell['type'] == 'user') {
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
        child: Align(
          alignment: Alignment.centerRight,
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width * .82,
            ),
            child: DecoratedBox(
              decoration: ShapeDecoration(
                color: c.primary,
                shape: NekoShape.squircle(NekoShape.bubble),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 11,
                ),
                child: SelectableText(
                  text,
                  style: TextStyle(
                    fontSize: 16,
                    height: 1.45,
                    color: c.onPrimary,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    final thinking = string(cell['thinking']);
    final streaming = cell['streaming'] == true;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (thinking.isNotEmpty || (streaming && text.isEmpty)) ...[
            ThinkingCard(cell: cell),
            const SizedBox(height: 10),
          ],
          if (text.isNotEmpty)
            MarkdownBody(
              data: text,
              selectable: true,
              styleSheet: nekoMarkdown(context),
              onTapLink: (_, href, _) => _openLink(href),
            ),
          if (streaming && text.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Row(
                children: [
                  MiuixInfiniteProgressIndicator(
                    color: c.primary,
                    size: 14,
                    strokeWidth: 1.8,
                  ),
                  const SizedBox(width: 8),
                  MiuixText(
                    '正在生成…',
                    fontSize: 13,
                    color: c.onSurfaceVariantSummary,
                  ),
                ],
              ),
            ),
          if (cell['error'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: MiuixText(
                string(cell['error']),
                fontSize: 14,
                color: c.error,
              ),
            ),
          if (text.isNotEmpty || cell['usage'] is Map)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                children: [
                  if (text.isNotEmpty)
                    MiuixPressable(
                      feedbackType: MiuixPressFeedbackType.sink,
                      onPressed: () {
                        Clipboard.setData(ClipboardData(text: text));
                        showNekoToast(context, '已复制回复');
                      },
                      semanticLabel: '复制回复',
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(0, 6, 12, 6),
                        child: MiuixIcon(
                          vector: MiuixIcons.os4.copy,
                          size: 18,
                          tint: c.onSurfaceVariantActions,
                        ),
                      ),
                    ),
                  if (cell['usage'] is Map)
                    Expanded(
                      child: MiuixText(
                        _usage(object(cell['usage'])),
                        fontSize: 12,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        color: c.onSurfaceVariantActions,
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  String _usage(Json usage) {
    final tokens = usage['totalTokens'] ?? 0;
    final seconds = usage['durationMs'] is num
        ? ' · ${((usage['durationMs'] as num) / 1000).toStringAsFixed(1)}s'
        : '';
    final cost = usage['costUsd'] == null ? '' : ' · \$${usage['costUsd']}';
    return '$tokens tokens · ${usage['calls'] ?? 0} 次调用$cost$seconds';
  }
}

/// Desktop ThinkingBlock: a bare header and five-line reasoning window.
class ThinkingCard extends StatefulWidget {
  const ThinkingCard({super.key, required this.cell});
  final Json cell;
  @override
  State<ThinkingCard> createState() => _ThinkingCardState();
}

class _ThinkingCardState extends State<ThinkingCard> {
  bool expanded = false;
  bool followTail = true;
  final scroll = ScrollController();
  bool get active =>
      widget.cell['streaming'] == true &&
      widget.cell['thinkingEndedAt'] == null;
  @override
  void didUpdateWidget(covariant ThinkingCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.cell['streaming'] == true && !active) expanded = false;
  }

  @override
  void dispose() {
    scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final text = string(widget.cell['thinking']);
    final preview =
        text
            .split('\n')
            .map((s) => s.trim())
            .where((s) => s.isNotEmpty)
            .lastOrNull ??
        '';
    if (active && expanded && followTail) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && scroll.hasClients) {
          scroll.jumpTo(scroll.position.maxScrollExtent);
        }
      });
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => setState(() => expanded = !expanded),
          child: Semantics(
            button: true,
            expanded: expanded,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                WorkflowChevron(open: expanded),
                const SizedBox(width: 4),
                WorkflowElapsed(
                  active: active,
                  working: false,
                  startedAt:
                      (widget.cell['thinkingStartedAt'] as num? ??
                              widget.cell['timestamp'] as num? ??
                              0)
                          .toInt(),
                  endedAt:
                      (widget.cell['thinkingEndedAt'] as num? ??
                              widget.cell['timestamp'] as num? ??
                              0)
                          .toInt(),
                  hasEnd: widget.cell['thinkingEndedAt'] != null,
                ),
              ],
            ),
          ),
        ),
        if (expanded && text.isNotEmpty) ...[
          const SizedBox(height: 4),
          WorkflowStyle.rail(
            context,
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 82.5),
              child: NotificationListener<ScrollNotification>(
                onNotification: (n) {
                  followTail = n.metrics.extentAfter < 8;
                  return false;
                },
                child: SingleChildScrollView(
                  controller: scroll,
                  physics: const ClampingScrollPhysics(),
                  child: SelectableText(
                    text,
                    style: WorkflowStyle.text(context, 11).copyWith(
                      color: WorkflowStyle.muted(
                        context,
                      ).withValues(alpha: .455),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ] else if (active && preview.isNotEmpty) ...[
          const SizedBox(height: 4),
          WorkflowStyle.rail(
            context,
            Text(
              preview,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: WorkflowStyle.text(context, 11).copyWith(
                color: WorkflowStyle.muted(context).withValues(alpha: .455),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// A whole run, using desktop WorkingBlock geometry. The result widgets below
/// ToolCell's header stay untouched and keep their original mobile styling.
class WorkingBlock extends StatefulWidget {
  const WorkingBlock({
    super.key,
    required this.row,
    required this.controller,
    required this.active,
    required this.waiting,
  });
  final TranscriptRow row;
  final MobileController controller;
  final bool active, waiting;
  @override
  State<WorkingBlock> createState() => _WorkingBlockState();
}

class _WorkingBlockState extends State<WorkingBlock> {
  late bool open = widget.active;
  @override
  void didUpdateWidget(covariant WorkingBlock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active && !widget.active) open = false;
  }

  @override
  Widget build(BuildContext context) {
    final tools = widget.row.items.where((i) => i.kind == 'tool').length;
    final last = widget.row.items.lastOrNull;
    final cell = last?.cell ?? <String, dynamic>{};
    final summary = widget.waiting
        ? 'Planning Next Step'
        : last?.kind == 'tool'
        ? presentTool(cell).subject
        : string(
                last?.kind == 'thinking' ? cell['thinking'] : cell['text'],
              ).split('\n').where((s) => s.trim().isNotEmpty).lastOrNull ??
              '';
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => setState(() => open = !open),
            child: Semantics(
              button: true,
              expanded: open,
              child: Row(
                children: [
                  WorkflowChevron(open: open, size: 16),
                  const SizedBox(width: 4),
                  if (widget.active) ...[
                    const WorkingOrb(),
                    const SizedBox(width: 4),
                  ],
                  Flexible(
                    child: WorkflowElapsed(
                      active: widget.active,
                      working: true,
                      startedAt: widget.row.startedAt,
                      endedAt: widget.row.endedAt,
                    ),
                  ),
                  if (!widget.active) ...[
                    const SizedBox(width: 4),
                    Text(
                      '· $tools tool ${tools == 1 ? 'call' : 'calls'}',
                      style: WorkflowStyle.text(context, 11).copyWith(
                        color: WorkflowStyle.muted(
                          context,
                        ).withValues(alpha: .455),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          if (open) ...[
            const SizedBox(height: 6),
            WorkflowStyle.rail(
              context,
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (var i = 0; i < widget.row.items.length; i++) ...[
                    if (i > 0) const SizedBox(height: 8),
                    TranscriptItem(
                      key: ValueKey(widget.row.items[i].id),
                      row: widget.row.items[i],
                      controller: widget.controller,
                      insideWork: true,
                    ),
                  ],
                  if (widget.waiting) ...[
                    if (widget.row.items.isNotEmpty) const SizedBox(height: 8),
                    const PlanningLine(),
                  ],
                ],
              ),
            ),
          ] else if (widget.active && summary.isNotEmpty) ...[
            const SizedBox(height: 6),
            WorkflowStyle.rail(
              context,
              WorkflowShimmer(
                active: widget.waiting,
                child: Text(
                  summary,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: WorkflowStyle.text(context, 11).copyWith(
                    color: WorkflowStyle.muted(context).withValues(alpha: .455),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class PlanningLine extends StatelessWidget {
  const PlanningLine({super.key});
  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.centerLeft,
    child: WorkflowShimmer(
      child: Text('Planning Next Step', style: WorkflowStyle.text(context)),
    ),
  );
}

class TranscriptItem extends StatelessWidget {
  const TranscriptItem({
    super.key,
    required this.row,
    required this.controller,
    this.insideWork = false,
  });
  final TranscriptRow row;
  final MobileController controller;
  final bool insideWork;
  @override
  Widget build(BuildContext context) {
    final cell = row.cell!;
    if (row.kind == 'tool') return ToolCell(cell: cell, controller: controller);
    if (row.kind == 'thinking') {
      final child = ThinkingCard(cell: cell);
      return insideWork
          ? child
          : Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
              child: child,
            );
    }
    if (row.kind == 'notice') {
      return Padding(
        padding: insideWork
            ? EdgeInsets.zero
            : const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Text(
          string(cell['text']),
          style: WorkflowStyle.text(
            context,
            10,
          ).copyWith(color: cell['level'] == 'error' ? context.mx.error : null),
        ),
      );
    }
    if (insideWork) {
      return MarkdownBody(
        data: string(cell['text']),
        selectable: true,
        styleSheet: nekoMarkdown(context, size: 13),
        onTapLink: (_, href, _) => _openLink(href),
      );
    }
    return MessageCell(cell: {...cell, 'thinking': ''}, controller: controller);
  }
}

/// 连续工具调用保持为轻量文字列表，不再套工作流卡片。
class ToolGroup extends StatelessWidget {
  const ToolGroup({super.key, required this.cells, required this.controller});
  final List<Json> cells;
  final MobileController controller;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final cell in cells)
            ToolCell(
              key: ValueKey(cell['id']),
              cell: cell,
              controller: controller,
            ),
        ],
      ),
    );
  }
}

/// 单个工具调用行：折叠时一行摘要，展开后显示参数 / 输出。
class ToolCell extends StatefulWidget {
  const ToolCell({super.key, required this.cell, required this.controller});
  final Json cell;
  final MobileController controller;

  @override
  State<ToolCell> createState() => _ToolCellState();
}

class _ToolCellState extends State<ToolCell> {
  bool expanded = false;
  String extra = '';
  bool loading = false;
  String? error;
  @override
  void didUpdateWidget(covariant ToolCell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.cell['output'] != widget.cell['output']) extra = '';
  }

  Future<void> fetchExtra() async {
    if (loading || extra.isNotEmpty || widget.controller.taskId == null) return;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final res = await widget.controller.desktop.request(
        '/api/tasks/${Uri.encodeComponent(widget.controller.taskId!)}/tool-result/${Uri.encodeComponent(string(widget.cell['id']))}',
      );
      if (mounted) {
        setState(() {
          extra = string(res['output']);
          loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          error = '$e';
          loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    final pres = presentTool(widget.cell);
    final output = string(widget.cell['output']);
    final effective = extra.isNotEmpty ? extra : output;
    final running = widget.cell['status'] == 'running';
    final failed = widget.cell['status'] == 'error';
    final hasMore = widget.cell['truncated'] == true && extra.isEmpty;
    final fallback = running ? (pres.isShell ? '等待命令输出…' : '执行中…') : '(无输出)';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _ToolCallHeader(
          cell: widget.cell,
          presentation: pres,
          running: running,
          failed: failed,
          expanded: expanded,
          onTap: () => setState(() => expanded = !expanded),
        ),
        if (expanded) ...[
          if (!pres.isShell)
            ToolResult(
              cell: widget.cell,
              output: effective,
              showDiffOnly: true,
            ),
          if (pres.isShell && pres.cwd != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: MiuixText(
                pres.cwd!,
                fontSize: 11.5,
                fontFamily: 'monospace',
                color: c.onSurfaceVariantActions,
              ),
            ),
          StepOutputCard(
            title: pres.isShell ? '终端输出' : '${pres.label} 输出',
            output: effective.isNotEmpty ? effective : fallback,
            maxHeight: 220,
          ),
          if (error != null)
            ErrorNotice(
              error,
              margin: const EdgeInsets.fromLTRB(10, 0, 10, 10),
            ),
          if (hasMore)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Center(
                child: loading
                    ? MiuixInfiniteProgressIndicator(
                        color: c.primary,
                        size: 16,
                        strokeWidth: 2,
                      )
                    : ActionButton(
                        '加载更多输出',
                        compact: true,
                        onPressed: fetchExtra,
                      ),
              ),
            ),
        ],
      ],
    );
  }
}

class _ToolCallHeader extends StatelessWidget {
  const _ToolCallHeader({
    required this.cell,
    required this.presentation,
    required this.running,
    required this.failed,
    required this.expanded,
    required this.onTap,
  });
  final Json cell;
  final ToolPresentation presentation;
  final bool running, failed, expanded;
  final VoidCallback onTap;

  String get action => presentation.label;

  @override
  Widget build(BuildContext context) {
    final foreground = WorkflowStyle.foreground(context).withValues(alpha: .8);
    final shell = presentation.isShell;
    final content = GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Semantics(
        button: true,
        expanded: expanded,
        child: Padding(
          padding: shell
              ? const EdgeInsets.symmetric(horizontal: 10, vertical: 6)
              : const EdgeInsets.symmetric(vertical: 2),
          child: Row(
            children: [
              SizedBox(
                width: 16,
                height: 16,
                child: Center(
                  child: WorkflowToolGlyph(
                    presentation: presentation,
                    running: running,
                    failed: failed,
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Text(
                action,
                style: WorkflowStyle.text(
                  context,
                ).copyWith(fontWeight: FontWeight.w500, color: foreground),
              ),
              if (presentation.subject.isNotEmpty) ...[
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    presentation.subject,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: WorkflowStyle.text(
                      context,
                      11,
                    ).copyWith(fontFamily: 'monospace'),
                  ),
                ),
              ] else
                const Spacer(),
              if (presentation.meta?.isNotEmpty == true) ...[
                const SizedBox(width: 10),
                Text(
                  presentation.meta!,
                  style: WorkflowStyle.text(context, 11),
                ),
              ],
              if (shell && cell['startedAt'] is num) ...[
                const SizedBox(width: 10),
                WorkflowToolDuration(
                  running: running,
                  startedAt: (cell['startedAt'] as num).toInt(),
                  endedAt: (cell['timestamp'] as num? ?? 0).toInt(),
                ),
              ],
              const SizedBox(width: 6),
              Opacity(
                opacity: expanded ? 1 : 0,
                child: WorkflowChevron(open: expanded),
              ),
            ],
          ),
        ),
      ),
    );
    return shell
        ? DecoratedBox(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: WorkflowStyle.rule(context)),
            ),
            child: content,
          )
        : content;
  }
}
