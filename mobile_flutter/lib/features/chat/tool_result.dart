import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import 'transcript.dart';

/// 结构化工具结果：文件差异、代码定位报告、退出状态码。
class ToolResult extends StatelessWidget {
  const ToolResult({
    super.key,
    required this.cell,
    required this.output,
    this.showDiffOnly = false,
  });

  final Json cell;
  final String output;
  final bool showDiffOnly;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    final name = string(cell['toolName'], string(cell['name']));
    final details = object(cell['details']);
    final diff = string(details['diff']);
    final result = diff.isNotEmpty ? diff : output;
    final isDiff =
        diff.isNotEmpty ||
        result.contains('@@ ') ||
        result.startsWith('diff --git');
    if (showDiffOnly && isDiff) return _DiffView(text: result);
    final exit = details['exitCode'];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (name == 'code_search') ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
            child: MiuixText(
              '定位报告',
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: c.primary,
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: MarkdownBody(
              data: output,
              selectable: true,
              styleSheet: nekoMarkdown(context, size: 13.5),
            ),
          ),
          for (final match in RegExp(
            r'([\w./\\-]+\.[\w]+):(\d+)(?:-(\d+))?',
          ).allMatches(output))
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
              child: SelectableText(
                match.group(0)!,
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12,
                  color: c.primary,
                ),
              ),
            ),
          const SizedBox(height: 8),
        ],
        if (isDiff) _DiffView(text: result),
        if (exit != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
            child: MiuixText(
              '退出状态码 $exit',
              fontSize: 12,
              fontFamily: 'monospace',
              color: exit == 0 ? NekoTone.success(context.isDark) : c.error,
            ),
          ),
      ],
    );
  }
}

class _DiffView extends StatelessWidget {
  const _DiffView({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    final dark = context.isDark;
    final add = NekoTone.success(dark);
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: NekoTone.codeBackground(dark),
          shape: NekoShape.squircle(14),
        ),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final line in text.split('\n')) _line(line, c, add),
            ],
          ),
        ),
      ),
    );
  }

  Widget _line(String line, MiuixColors c, Color add) {
    final isAdd = line.startsWith('+') && !line.startsWith('+++');
    final isDel = line.startsWith('-') && !line.startsWith('---');
    final color = isAdd
        ? add
        : isDel
        ? c.error
        : line.startsWith('@')
        ? c.primary
        : c.onSurfaceVariantSummary;
    return Container(
      color: isAdd
          ? add.withValues(alpha: .1)
          : isDel
          ? c.error.withValues(alpha: .1)
          : null,
      child: SelectableText(
        line.isEmpty ? ' ' : line,
        style: TextStyle(
          fontFamily: 'monospace',
          fontSize: 11.5,
          height: 1.5,
          color: color,
        ),
      ),
    );
  }
}
