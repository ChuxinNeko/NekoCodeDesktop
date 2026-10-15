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
            _ThinkingCard(
              thinking: thinking,
              streaming: streaming && text.isEmpty,
            ),
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

/// 思考过程（可折叠）。
class _ThinkingCard extends StatefulWidget {
  const _ThinkingCard({required this.thinking, required this.streaming});
  final String thinking;
  final bool streaming;
  @override
  State<_ThinkingCard> createState() => _ThinkingCardState();
}

class _ThinkingCardState extends State<_ThinkingCard> {
  bool expanded = false;
  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    final canOpen = widget.thinking.isNotEmpty;
    return DecoratedBox(
      decoration: ShapeDecoration(
        color: c.surfaceContainer,
        shape: NekoShape.squircle(NekoShape.card - 4),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          StepHeader(
            verb: widget.streaming ? '正在思考…' : '已思考',
            running: widget.streaming,
            expanded: expanded,
            onToggle: canOpen
                ? () => setState(() => expanded = !expanded)
                : null,
            icon: MiuixIcon(
              vector: MiuixIcons.os4.memoryFunction,
              size: 18,
              tint: c.onSurfaceVariantSummary,
            ),
          ),
          if (expanded && canOpen)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
              child: SelectableText(
                widget.thinking,
                style: TextStyle(
                  fontSize: 13.5,
                  height: 1.55,
                  color: c.onSurfaceVariantSummary,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 连续的工具调用合并为一张卡片，行间用发丝线分隔。
class ToolGroup extends StatelessWidget {
  const ToolGroup({super.key, required this.cells, required this.controller});
  final List<Json> cells;
  final MobileController controller;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: c.surfaceContainer,
          shape: NekoShape.squircle(NekoShape.card - 4),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < cells.length; i++) ...[
              if (i > 0)
                Padding(
                  padding: const EdgeInsets.only(left: 44),
                  child: ColoredBox(
                    color: c.dividerLine.withValues(alpha: .6),
                    child: const SizedBox(height: .5),
                  ),
                ),
              ToolCell(
                key: ValueKey(cells[i]['id']),
                cell: cells[i],
                controller: controller,
              ),
            ],
          ],
        ),
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
        StepHeader(
          verb: pres.label,
          object: pres.isShell
              ? '${pres.prompt} ${pres.subject}'
              : pres.subject,
          mono: pres.isShell,
          detail: pres.meta,
          running: running,
          expanded: expanded,
          onToggle: () => setState(() => expanded = !expanded),
          icon: Icon(
            pres.icon,
            size: 18,
            color: failed ? c.error : c.onSurfaceVariantSummary,
          ),
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
