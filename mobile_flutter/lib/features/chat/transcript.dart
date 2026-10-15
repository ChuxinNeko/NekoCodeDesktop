import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';
import 'tool_result.dart';

class MessageCell extends StatelessWidget {
  const MessageCell({super.key, required this.cell, required this.controller});
  final Json cell;
  final MobileController controller;

  @override
  Widget build(BuildContext context) {
    if (cell['type'] == 'tool') {
      return ToolCell(
        key: ValueKey(cell['id']),
        cell: cell,
        controller: controller,
      );
    }

    final isDark = Theme.of(context).brightness == Brightness.dark;
    final user = cell['type'] == 'user';
    final text = string(cell['text']);
    final thinking = string(cell['thinking']);

    // BaoCode 风格用户消息气泡 (UserMessageBubble)
    if (user) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(width: 44),
            Flexible(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: isDark ? BaoColors.darkBubbleFill : BaoColors.lightBubbleFill,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: isDark ? BaoColors.darkBubbleBorder : BaoColors.lightBubbleBorder,
                    width: 0.8,
                  ),
                ),
                child: SelectableText(
                  text,
                  style: TextStyle(
                    fontSize: 14,
                    height: 1.5,
                    color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                    leadingDistribution: TextLeadingDistribution.even,
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    }

    // BaoCode 风格 AI 助手沉浸式流排版
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // BaoCode 风格思考过程折叠块 (ThinkingSection)
          if (thinking.isNotEmpty || (cell['streaming'] == true && text.isEmpty)) ...[
            _BaoThinkingCard(
              thinking: thinking,
              streaming: cell['streaming'] == true && text.isEmpty,
            ),
            const SizedBox(height: 6),
          ],

          // 核心 Markdown 回复流
          if (text.isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: MarkdownBody(
                data: text,
                selectable: true,
                styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
                  p: TextStyle(
                    fontSize: 14.5,
                    height: 1.55,
                    color: isDark ? BaoColors.darkText : BaoColors.lightText,
                  ),
                  codeblockDecoration: BoxDecoration(
                    color: isDark ? BaoColors.darkCodeBg : BaoColors.lightCodeBg,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(
                      color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
                      width: 0.8,
                    ),
                  ),
                  code: TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12.5,
                    color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                    backgroundColor: isDark ? const Color(0xFF282828) : const Color(0xFFE5E5E5),
                  ),
                  blockquoteDecoration: BoxDecoration(
                    border: Border(
                      left: BorderSide(
                        color: isDark ? BaoColors.accent : const Color(0xFF005FB8),
                        width: 3,
                      ),
                    ),
                  ),
                ),
                onTapLink: (_, href, _) async {
                  final uri = Uri.tryParse(href ?? '');
                  if (uri != null && ['https', 'http'].contains(uri.scheme)) {
                    await launchUrl(uri, mode: LaunchMode.externalApplication);
                  }
                },
              ),
            ),

          // 流式生成进度提示
          if (cell['streaming'] == true && text.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                children: [
                  const SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(
                      strokeWidth: 1.8,
                      valueColor: AlwaysStoppedAnimation<Color>(BaoColors.accent),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'Agent 正在生成…',
                    style: TextStyle(
                      fontSize: 12,
                      color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                    ),
                  ),
                ],
              ),
            ),

          // 错误提示
          if (cell['error'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                string(cell['error']),
                style: const TextStyle(color: BaoColors.red, fontSize: 13),
              ),
            ),

          // 底部用量与操作信息 (tokens · 次调用 · 复制)
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              if (cell['usage'] is Map)
                Text(
                  _usage(object(cell['usage'])),
                  style: TextStyle(
                    fontSize: 11,
                    color: isDark ? BaoColors.darkTextFaint : BaoColors.lightTextFaint,
                  ),
                )
              else
                const SizedBox.shrink(),
              if (text.isNotEmpty)
                IconButton(
                  tooltip: '复制回复',
                  splashRadius: 16,
                  icon: Icon(
                    Icons.copy_rounded,
                    size: 14,
                    color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                  ),
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: text));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('已复制回复'),
                        duration: Duration(milliseconds: 1200),
                        behavior: SnackBarBehavior.floating,
                      ),
                    );
                  },
                ),
            ],
          ),
        ],
      ),
    );
  }

  String _usage(Json usage) =>
      '${usage['totalTokens'] ?? 0} tokens · ${usage['calls'] ?? 0} 次调用${usage['costUsd'] == null ? '' : ' · \$${usage['costUsd']}'}${usage['durationMs'] == null ? '' : ' · ${((usage['durationMs'] as num) / 1000).toStringAsFixed(1)}s'}';
}

/// 思考过程折叠组件
class _BaoThinkingCard extends StatefulWidget {
  const _BaoThinkingCard({required this.thinking, required this.streaming});
  final String thinking;
  final bool streaming;

  @override
  State<_BaoThinkingCard> createState() => _BaoThinkingCardState();
}

class _BaoThinkingCardState extends State<_BaoThinkingCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    final verb = widget.streaming ? 'Thinking...' : 'Thought';
    final detail = widget.streaming ? 'processing' : 'completed';

    return Container(
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF1B1B1C) : const Color(0xFFF7F7F8),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(
          color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
          width: 0.8,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          StepHeader(
            verb: verb,
            detail: detail,
            running: widget.streaming,
            expanded: _expanded,
            onToggle: () => setState(() => _expanded = !_expanded),
            icon: Icon(
              Icons.auto_awesome_rounded,
              size: 14,
              color: widget.streaming ? BaoColors.amber : (isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary),
            ),
          ),
          if (_expanded && widget.thinking.isNotEmpty)
            Container(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
              child: SelectableText(
                widget.thinking,
                style: TextStyle(
                  fontSize: 12.5,
                  height: 1.5,
                  color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// -----------------------------------------------------------------------------
// NekoCode Desktop 风格工具调用展示规范 (复用 NekoCodeDesktop ToolCalls.tsx 架构)
// -----------------------------------------------------------------------------

class _ToolPresentation {
  const _ToolPresentation({
    required this.label,
    required this.subject,
    required this.icon,
    this.meta,
    this.isShell = false,
    this.prompt = '\$',
    this.cwd,
  });

  final String label;
  final String subject;
  final IconData icon;
  final String? meta;
  final bool isShell;
  final String prompt;
  final String? cwd;
}

_ToolPresentation _presentTool(Json cell) {
  final name = string(cell['name'], string(cell['toolName']));
  final input = cell['input'] ?? cell['args'];
  final details = object(cell['details']);

  // 参数提取辅助
  String? argString(String key) {
    if (input is Map && input[key] is String && (input[key] as String).isNotEmpty) {
      return input[key] as String;
    }
    return null;
  }

  int? argNumber(String key) {
    if (input is Map && input[key] is num) return (input[key] as num).toInt();
    return null;
  }

  String pathBasename(String p) => p.split(RegExp(r'[\\/]')).where((s) => s.isNotEmpty).lastOrNull ?? p;

  // 1. Terminal / Shell 命令类工具 (对应 NekoCode Desktop TerminalCard)
  if (name == 'bash' || name == 'powershell' || name == 'cmd' || name == 'terminal') {
    final cmd = argString('command') ?? (input is String ? input : '');
    final cwd = argString('cwd');
    final prompt = name == 'powershell' ? 'PS>' : (name == 'cmd' ? '>' : '\$');
    return _ToolPresentation(
      label: '运行命令',
      subject: cmd.split('\n').firstOrNull ?? cmd,
      icon: Icons.terminal_rounded,
      isShell: true,
      prompt: prompt,
      cwd: cwd,
    );
  }

  if (name == 'ssh' && argString('op') == 'exec') {
    final host = argString('host') ?? 'ssh';
    final cmd = argString('command') ?? '';
    return _ToolPresentation(
      label: host,
      subject: cmd.split('\n').firstOrNull ?? cmd,
      icon: Icons.dns_rounded,
      isShell: true,
      prompt: '$host \$',
    );
  }

  // 2. 读文件 (read)
  if (name == 'read' || name == 'readFile') {
    final p = argString('path') ?? '';
    final offset = argNumber('offset');
    final limit = argNumber('limit');
    String? meta;
    if (offset != null && limit != null) {
      meta = 'L$offset–${offset + limit - 1}';
    } else if (offset != null) {
      meta = 'L$offset+';
    } else if (limit != null) {
      meta = 'L1–$limit';
    }
    return _ToolPresentation(
      label: '读取文件',
      subject: p.isNotEmpty ? pathBasename(p) : '文件',
      icon: Icons.description_outlined,
      meta: meta,
    );
  }

  // 3. 编辑/写入文件 (edit / write)
  if (name == 'edit' || name == 'write' || name == 'writeFile') {
    final p = argString('path') ?? '';
    return _ToolPresentation(
      label: name == 'edit' ? '编辑文件' : '写入文件',
      subject: p.isNotEmpty ? pathBasename(p) : '文件',
      icon: Icons.edit_note_rounded,
    );
  }

  // 4. 搜索与定位 (grep / find / semantic_search / code_search / ast_grep)
  if (name == 'grep') {
    return _ToolPresentation(
      label: '搜索',
      subject: argString('pattern') ?? '',
      icon: Icons.search_rounded,
    );
  }
  if (name == 'find') {
    return _ToolPresentation(
      label: '查找文件',
      subject: argString('pattern') ?? '',
      icon: Icons.manage_search_rounded,
    );
  }
  if (name == 'code_search') {
    return _ToolPresentation(
      label: '定位代码',
      subject: argString('query') ?? '',
      icon: Icons.saved_search_rounded,
    );
  }
  if (name == 'semantic_search') {
    return _ToolPresentation(
      label: '语义搜索',
      subject: argString('query') ?? '',
      icon: Icons.travel_explore_rounded,
      meta: argString('path'),
    );
  }
  if (name == 'ls') {
    final p = argString('path') ?? '.';
    return _ToolPresentation(
      label: '列出目录',
      subject: pathBasename(p),
      icon: Icons.folder_open_rounded,
    );
  }
  if (name == 'stat') {
    return _ToolPresentation(
      label: '测量文件',
      subject: argString('path') ?? '',
      icon: Icons.straighten_rounded,
    );
  }
  if (name == 'github') {
    return _ToolPresentation(
      label: 'GitHub',
      subject: [argString('repo'), argString('op')].where((s) => s != null && s.isNotEmpty).join(' · '),
      icon: Icons.commit_rounded,
    );
  }
  if (name == 'web_search') {
    return _ToolPresentation(
      label: '网页搜索',
      subject: argString('query') ?? '',
      icon: Icons.language_rounded,
    );
  }
  if (name == 'web_fetch') {
    final url = argString('url') ?? '';
    return _ToolPresentation(
      label: '抓取网页',
      subject: url,
      icon: Icons.public_rounded,
    );
  }

  // 默认普通工具
  return _ToolPresentation(
    label: name,
    subject: argString('command') ?? argString('path') ?? argString('query') ?? '',
    icon: Icons.build_outlined,
  );
}

/// NekoCode Desktop 风格工具调用折叠单元 (ToolCell)
class ToolCell extends StatefulWidget {
  const ToolCell({super.key, required this.cell, required this.controller});
  final Json cell;
  final MobileController controller;

  @override
  State<ToolCell> createState() => _ToolCellState();
}

class _ToolCellState extends State<ToolCell> {
  bool _expanded = false;
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
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final pres = _presentTool(widget.cell);
    final output = string(widget.cell['output']);
    final effectiveOutput = extra.isNotEmpty ? extra : output;
    final running = widget.cell['status'] == 'running';
    final isError = widget.cell['status'] == 'error';
    final hasMore = widget.cell['truncated'] == true && extra.isEmpty;

    final border = isDark ? BaoColors.darkBorder : BaoColors.lightBorder;
    final cardBg = isDark ? BaoColors.darkCodeBg : BaoColors.lightCodeBg;

    // 如果是命令工具 (TerminalCard 风格)
    if (pres.isShell) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
        child: Container(
          decoration: BoxDecoration(
            color: isDark ? const Color(0xFF181818) : const Color(0xFFFAFAFA),
            borderRadius: BorderRadius.circular(6),
            border: Border.all(
              color: isError ? BaoColors.red.withValues(alpha: 0.6) : border,
              width: 0.8,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // 桌面端风格 Header
              InkWell(
                onTap: () => setState(() => _expanded = !_expanded),
                borderRadius: const BorderRadius.vertical(top: Radius.circular(6)),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                  child: Row(
                    children: [
                      // 左侧状态指示图标
                      if (running)
                        const SizedBox(
                          width: 13,
                          height: 13,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.6,
                            valueColor: AlwaysStoppedAnimation<Color>(BaoColors.accent),
                          ),
                        )
                      else
                        Icon(
                          pres.icon,
                          size: 14,
                          color: isError
                              ? BaoColors.red
                              : (isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary),
                        ),
                      const SizedBox(width: 8),

                      // 动词标签
                      Text(
                        pres.label,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                        ),
                      ),
                      const SizedBox(width: 8),

                      // 命令单行摘要
                      Expanded(
                        child: Text(
                          pres.subject,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 11.5,
                            color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                          ),
                        ),
                      ),

                      // 状态与折叠箭头
                      if (running)
                        Padding(
                          padding: const EdgeInsets.only(left: 6),
                          child: Text(
                            '运行中…',
                            style: TextStyle(
                              fontSize: 11,
                              color: isDark ? BaoColors.amber : const Color(0xFFB45309),
                            ),
                          ),
                        ),
                      const SizedBox(width: 4),
                      Icon(
                        _expanded ? Icons.keyboard_arrow_down_rounded : Icons.chevron_right_rounded,
                        size: 15,
                        color: isDark ? BaoColors.darkTextFaint : BaoColors.lightTextFaint,
                      ),
                    ],
                  ),
                ),
              ),

              // 展开后的黑底终端窗口
              if (_expanded) ...[
                Container(
                  decoration: BoxDecoration(
                    color: cardBg,
                    border: Border(top: BorderSide(color: border, width: 0.6)),
                    borderRadius: const BorderRadius.vertical(bottom: Radius.circular(6)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // 命令提示行 PS> / $ command · cwd
                      Padding(
                        padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${pres.prompt} ',
                              style: TextStyle(
                                fontFamily: 'monospace',
                                fontSize: 11.5,
                                fontWeight: FontWeight.bold,
                                color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                              ),
                            ),
                            Expanded(
                              child: SelectableText.rich(
                                TextSpan(
                                  children: [
                                    TextSpan(
                                      text: pres.subject,
                                      style: TextStyle(
                                        fontFamily: 'monospace',
                                        fontSize: 11.5,
                                        fontWeight: FontWeight.w500,
                                        color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                                      ),
                                    ),
                                    if (pres.cwd != null)
                                      TextSpan(
                                        text: '  ·  ${pres.cwd}',
                                        style: TextStyle(
                                          fontFamily: 'monospace',
                                          fontSize: 10.5,
                                          color: isDark ? BaoColors.darkTextFaint : BaoColors.lightTextFaint,
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      // 终端输出流
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxHeight: 220),
                        child: SingleChildScrollView(
                          padding: const EdgeInsets.fromLTRB(10, 4, 10, 8),
                          child: SelectableText(
                            effectiveOutput.isNotEmpty
                                ? effectiveOutput
                                : (running ? '等待命令输出…' : '(无输出)'),
                            style: TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 11.5,
                              height: 1.4,
                              color: isError
                                  ? BaoColors.red
                                  : (isDark ? BaoColors.darkText : BaoColors.lightText),
                            ),
                          ),
                        ),
                      ),
                      // 加载更多
                      if (hasMore)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: Center(
                            child: loading
                                ? const SizedBox(
                                    width: 14,
                                    height: 14,
                                    child: CircularProgressIndicator(strokeWidth: 1.6),
                                  )
                                : TextButton.icon(
                                    onPressed: fetchExtra,
                                    icon: const Icon(Icons.expand_more_rounded, size: 14),
                                    label: const Text('加载更多输出', style: TextStyle(fontSize: 11.5)),
                                  ),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      );
    }

    // 其它工具调用：标准 ToolRow + 展开 Output 结构
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          StepHeader(
            verb: pres.label,
            object: pres.subject,
            detail: pres.meta ?? (running ? 'running' : null),
            running: running,
            expanded: _expanded,
            onToggle: () => setState(() => _expanded = !_expanded),
            icon: Icon(
              pres.icon,
              size: 14,
              color: isError
                  ? BaoColors.red
                  : (isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary),
            ),
          ),
          if (_expanded) ...[
            // 如果包含差异或结构化定位，优先使用桌面端 ToolResult 结构
            ToolResult(
              cell: widget.cell,
              output: effectiveOutput,
              showDiffOnly: true,
            ),
            StepOutputCard(
              title: '${pres.label} 输出',
              output: effectiveOutput.isNotEmpty
                  ? effectiveOutput
                  : (running ? '执行中…' : '(无输出)'),
            ),
            if (hasMore)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Center(
                  child: loading
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 1.6),
                        )
                      : TextButton.icon(
                          onPressed: fetchExtra,
                          icon: const Icon(Icons.expand_more_rounded, size: 14),
                          label: const Text('加载更多输出', style: TextStyle(fontSize: 11.5)),
                        ),
                ),
              ),
          ],
        ],
      ),
    );
  }
}
