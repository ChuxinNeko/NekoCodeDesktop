import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';

/// NekoCode Desktop 风格结构化结果展示与文件差异卡片
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
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final name = string(cell['toolName'], string(cell['name']));
    final details = object(cell['details']);
    final diff = string(details['diff']);
    final result = diff.isNotEmpty ? diff : output;
    final isDiff = diff.isNotEmpty || result.contains('@@ ') || result.startsWith('diff --git');

    if (showDiffOnly && isDiff) {
      return _buildDiffView(context, result, isDark);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (name == 'code_search') ...[
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            child: Row(
              children: [
                const Icon(Icons.saved_search_rounded, size: 14, color: BaoColors.accent),
                const SizedBox(width: 6),
                Text(
                  'Fast Context · 定位报告',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: MarkdownBody(
              data: output,
              selectable: true,
              styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
                p: TextStyle(
                  fontSize: 12,
                  color: isDark ? BaoColors.darkText : BaoColors.lightText,
                ),
                code: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                  backgroundColor: isDark ? const Color(0xFF262626) : const Color(0xFFE5E5E5),
                ),
              ),
            ),
          ),
          for (final match in RegExp(r'([\w./\\-]+\.[\w]+):(\d+)(?:-(\d+))?').allMatches(output))
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
              child: SelectableText(
                match.group(0)!,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 11.5,
                  color: BaoColors.accent,
                ),
              ),
            ),
          const SizedBox(height: 6),
        ],
        if (isDiff) _buildDiffView(context, result, isDark),
        if (details['exitCode'] != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            child: Text(
              '退出状态码：${details['exitCode']}',
              style: TextStyle(
                fontSize: 11,
                fontFamily: 'monospace',
                color: details['exitCode'] == 0 ? BaoColors.green : BaoColors.red,
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildDiffView(BuildContext context, String diffText, bool isDark) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF141414) : const Color(0xFFF6F6F6),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(
          color: isDark ? BaoColors.darkBorderSubtle : BaoColors.lightBorderSubtle,
          width: 0.6,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: isDark ? const Color(0xFF1E1E1E) : const Color(0xFFEFEFEF),
              border: Border(
                bottom: BorderSide(
                  color: isDark ? BaoColors.darkBorderSubtle : BaoColors.lightBorderSubtle,
                  width: 0.6,
                ),
              ),
            ),
            child: Row(
              children: [
                const Icon(Icons.difference_rounded, size: 13, color: BaoColors.accent),
                const SizedBox(width: 5),
                Text(
                  '文件变更差异 (Diff)',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                  ),
                ),
              ],
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final line in diffText.split('\n'))
                    SelectableText(
                      line,
                      style: TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 11,
                        height: 1.35,
                        color: line.startsWith('+') && !line.startsWith('+++')
                            ? BaoColors.green
                            : line.startsWith('-') && !line.startsWith('---')
                            ? BaoColors.red
                            : line.startsWith('@')
                            ? BaoColors.accent
                            : (isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
