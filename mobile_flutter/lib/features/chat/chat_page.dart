import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';
import 'configuration.dart';
import 'run_details.dart';
import 'transcript.dart';
import 'workflow_panel.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    required this.controller,
    required this.onPickProject,
  });

  final MobileController controller;
  final VoidCallback onPickProject;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final text = TextEditingController();
  final scroll = ScrollController();
  final FocusNode inputFocus = FocusNode();
  bool sending = false, commandsLoading = false;
  String? _tail;
  String? _extensionEditor;

  MobileController get c => widget.controller;

  @override
  void dispose() {
    text.dispose();
    scroll.dispose();
    inputFocus.dispose();
    super.dispose();
  }

  Future<void> send() async {
    if (sending) return;
    final draft = text.text;
    setState(() => sending = true);
    final ok = await c.send(draft);
    if (mounted) {
      setState(() {
        sending = false;
        if (ok && text.text == draft) text.clear();
      });
    }
  }

  Future<void> commands() async {
    if (commandsLoading) return;
    setState(() => commandsLoading = true);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    try {
      final values = c.isAcp
          ? records(c.snapshot?['commands'])
          : c.taskId == null
          ? <Json>[]
          : records(
              await c.desktop.request(
                '/api/tasks/${Uri.encodeComponent(c.taskId!)}/commands',
              ),
            );
      if (!mounted) return;
      final command = await showModalBottomSheet<String>(
        context: context,
        isScrollControlled: true,
        backgroundColor: isDark ? BaoColors.darkSurface : BaoColors.lightSurface,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
          side: BorderSide(color: BaoColors.darkBorder, width: 0.8),
        ),
        builder: (context) => SafeArea(
          child: SizedBox(
            height: MediaQuery.sizeOf(context).height * .55,
            child: Column(
              children: [
                Center(
                  child: Container(
                    margin: const EdgeInsets.symmetric(vertical: 8),
                    width: 36,
                    height: 4,
                    decoration: BoxDecoration(
                      color: isDark ? BaoColors.darkBorderSubtle : BaoColors.lightBorderSubtle,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                  child: Row(
                    children: [
                      Icon(
                        Icons.terminal_rounded,
                        size: 16,
                        color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        '可用斜杠命令 (/commands)',
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                        ),
                      ),
                    ],
                  ),
                ),
                const Divider(),
                Expanded(
                  child: values.isEmpty
                      ? Center(
                          child: Text(
                            '当前会话暂无可用命令',
                            style: TextStyle(
                              color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                              fontSize: 13,
                            ),
                          ),
                        )
                      : ListView.separated(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          itemCount: values.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 4),
                          itemBuilder: (_, i) {
                            final v = values[i];
                            return Material(
                              color: isDark ? BaoColors.darkSidebarBg : BaoColors.lightSidebarBg,
                              shape: const MiuixSquircleBorder(
                                cornerRadius: 10,
                                side: BorderSide(
                                  color: BaoColors.darkBorder,
                                  width: 0.6,
                                ),
                              ),
                              child: ListTile(
                                dense: true,
                                shape: const MiuixSquircleBorder(cornerRadius: 10),
                                leading: Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                                  decoration: ShapeDecoration(
                                    color: BaoColors.accent.withValues(alpha: 0.15),
                                    shape: const MiuixSquircleBorder(cornerRadius: 6),
                                  ),
                                  child: Text(
                                    '/${v['name']}',
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w600,
                                      fontSize: 12,
                                      fontFamily: 'monospace',
                                      color: BaoColors.accent,
                                    ),
                                  ),
                                ),
                                title: Text(
                                  string(v['description']),
                                  style: TextStyle(
                                    fontSize: 12.5,
                                    color: isDark ? BaoColors.darkText : BaoColors.lightText,
                                  ),
                                ),
                                onTap: () => Navigator.pop(context, '/${v['name']} '),
                              ),
                            );
                          },
                        ),
                ),
              ],
            ),
          ),
        ),
      );
      if (command != null && mounted) {
        text.text = command;
        text.selection = TextSelection.collapsed(offset: text.text.length);
      }
    } catch (e) {
      c.error = '$e';
      c.emit();
    } finally {
      if (mounted) setState(() => commandsLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final extension = object(c.snapshot?['extensionUi']);
    final editor = object(extension['editor']);
    if (editor['id'] is String && editor['id'] != _extensionEditor) {
      _extensionEditor = editor['id'] as String;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        final insertion = string(editor['text']);
        if (editor['mode'] == 'replace') {
          text.text = insertion;
        } else {
          final selection = text.selection;
          final start = selection.isValid ? selection.start : text.text.length;
          final end = selection.isValid ? selection.end : text.text.length;
          text.text = text.text.replaceRange(start, end, insertion);
          text.selection = TextSelection.collapsed(
            offset: start + insertion.length,
          );
        }
        setState(() {});
      });
    }

    final cells = records(c.snapshot?['cells']);
    final tail = cells.isEmpty
        ? ''
        : '${cells.last['id']}:${cells.last['text']}:${cells.last['output']}';
    if (tail != _tail) {
      final follow = !scroll.hasClients || scroll.position.extentAfter < 140;
      _tail = tail;
      if (follow) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && scroll.hasClients) {
            scroll.jumpTo(scroll.position.maxScrollExtent);
          }
        });
      }
    }

    final workflow = object(c.snapshot?['workflow']);
    final running =
        c.snapshot?['streaming'] == true ||
        c.snapshot?['status'] == 'prompting' ||
        records(workflow['tasks']).any((t) => t['status'] == 'running');
    final blocked =
        c.busy ||
        !c.online ||
        sending ||
        workflow['request'] != null ||
        (!c.isAcp && c.taskId == null && c.defaults == null);

    return Column(
      children: [
        ErrorNotice(
          c.error,
          onDismiss: () {
            c.error = null;
            c.emit();
          },
        ),

        // 消息展示区
        Expanded(
          child: c.snapshot == null && (c.taskId != null || c.acpId != null)
              ? const Center(
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    valueColor: AlwaysStoppedAnimation<Color>(BaoColors.accent),
                  ),
                )
              : cells.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Container(
                          width: 52,
                          height: 52,
                          decoration: ShapeDecoration(
                            color: isDark ? BaoColors.darkSurface : BaoColors.lightSurface,
                            shape: const MiuixSquircleBorder(
                              cornerRadius: 14,
                              side: BorderSide(
                                color: BaoColors.darkBorder,
                                width: 0.8,
                              ),
                            ),
                          ),
                          child: const Icon(
                            Icons.terminal_rounded,
                            color: BaoColors.accent,
                            size: 26,
                          ),
                        ),
                        const SizedBox(height: 14),
                        Text(
                          'NekoCode Agent 工作台',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            letterSpacing: -0.2,
                            color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          'HyperOS 4 动效与质感 · 输入消息即刻执行任务',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 12.5,
                            color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                )
              : ListView.builder(
                  controller: scroll,
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  itemCount: cells.length + (c.desktop.more && !c.isAcp ? 1 : 0),
                  itemBuilder: (_, index) {
                    if (c.desktop.more && !c.isAcp) {
                      if (index == 0) {
                        return Center(
                          child: TextButton.icon(
                            onPressed: c.loadingEarlier
                                ? null
                                : () async {
                                    final before = scroll.position.maxScrollExtent;
                                    final offset = scroll.offset;
                                    await c.earlier();
                                    WidgetsBinding.instance.addPostFrameCallback((_) {
                                      if (mounted && scroll.hasClients) {
                                        scroll.jumpTo(
                                          (offset + scroll.position.maxScrollExtent - before).clamp(
                                            0,
                                            scroll.position.maxScrollExtent,
                                          ),
                                        );
                                      }
                                    });
                                  },
                            icon: const Icon(Icons.history_rounded, size: 14),
                            label: Text(
                              c.loadingEarlier ? '加载中…' : '查看更早历史',
                              style: const TextStyle(fontSize: 12),
                            ),
                          ),
                        );
                      }
                      index--;
                    }
                    return MessageCell(
                      key: ValueKey(cells[index]['id']),
                      cell: cells[index],
                      controller: c,
                    );
                  },
                ),
        ),

        if (c.snapshot?['error'] != null && c.snapshot?['error'] != c.error)
          ErrorNotice(string(c.snapshot?['error'])),

        // 底部操作确认横幅 (WorkflowPanel)
        WorkflowPanel(controller: c),
        ExtensionWidgets(
          ui: extension,
          below: false,
          onAnswer: c.answerExtension,
          streaming: c.snapshot?['streaming'] == true,
        ),
        ConfigurationBar(controller: c),

        // -----------------------------------------------------------------------------
        // flutter_miuix HyperOS 4 风格底栏与 Composer 消息输入框
        // -----------------------------------------------------------------------------
        Container(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
          decoration: BoxDecoration(
            color: isDark ? const Color(0xFF161616) : const Color(0xFFF7F7F7),
            border: Border(
              top: BorderSide(
                color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
                width: 0.6,
              ),
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // 状态指示条（Commands 快速按钮 + Token 用量）
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    MiuixButton(
                      onPressed: commandsLoading ? null : commands,
                      cornerRadius: 8,
                      minHeight: 28,
                      minWidth: 80,
                      insideMargin: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            '/',
                            style: TextStyle(
                              fontFamily: 'monospace',
                              fontWeight: FontWeight.bold,
                              fontSize: 12,
                              color: BaoColors.accent,
                            ),
                          ),
                          SizedBox(width: 4),
                          Text(
                            'Commands',
                            style: TextStyle(fontSize: 11),
                          ),
                        ],
                      ),
                    ),
                    const Spacer(),
                    if (c.snapshot?['context'] is Map)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        decoration: ShapeDecoration(
                          color: isDark ? const Color(0xFF222222) : const Color(0xFFEBEBEB),
                          shape: const MiuixSquircleBorder(cornerRadius: 6),
                        ),
                        child: Text(
                          'Tokens: ${object(c.snapshot!['context'])['used']} / ${object(c.snapshot!['context'])['window']}',
                          style: TextStyle(
                            fontSize: 11,
                            fontFamily: 'monospace',
                            color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                          ),
                        ),
                      ),
                  ],
                ),
              ),

              // HyperOS 4 胶囊输入容器 (Squircle 连续超椭圆 + MiuixTextField + 动作按钮)
              Container(
                decoration: ShapeDecoration(
                  color: isDark ? const Color(0xFF242424) : const Color(0xFFFFFFFF),
                  shape: MiuixSquircleBorder(
                    cornerRadius: 18,
                    side: BorderSide(
                      color: isDark ? const Color(0xFF383838) : const Color(0xFFE2E2E2),
                      width: 0.8,
                    ),
                  ),
                ),
                padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    // MiuixTextField 超椭圆浮动输入框
                    Expanded(
                      child: MiuixTextField(
                        controller: text,
                        focusNode: inputFocus,
                        label: '给 NekoCode 发消息或 / 命令…',
                        useLabelAsPlaceholder: true,
                        cornerRadius: 14,
                        insideMargin: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                        enabled: !sending,
                        maxLines: 5,
                        minLines: 1,
                        textStyle: TextStyle(
                          fontSize: 14,
                          color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                        ),
                        colors: MiuixTextFieldColors(
                          backgroundColor: Colors.transparent,
                          labelColor: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                          borderColor: Colors.transparent,
                        ),
                        onChanged: (_) => setState(() {}),
                      ),
                    ),
                    const SizedBox(width: 4),

                    // HyperOS 4 风格发送 / 停止按钮
                    Padding(
                      padding: const EdgeInsets.only(bottom: 3, right: 2),
                      child: MiuixButton(
                        colors: MiuixButtonColors(
                          color: running
                              ? BaoColors.red
                              : (blocked || text.text.trim().isEmpty)
                              ? (isDark ? const Color(0xFF333333) : const Color(0xFFDCDCDC))
                              : BaoColors.accent,
                          disabledColor: isDark ? const Color(0xFF282828) : const Color(0xFFE0E0E0),
                          contentColor: Colors.white,
                          disabledContentColor: isDark ? Colors.white30 : Colors.black26,
                        ),
                        cornerRadius: 14,
                        minHeight: 36,
                        minWidth: 42,
                        insideMargin: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                        onPressed: running
                            ? (c.busy ? null : c.abort)
                            : (blocked || text.text.trim().isEmpty ? null : send),
                        child: Icon(
                          running ? Icons.stop_rounded : Icons.arrow_upward_rounded,
                          size: 18,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        ExtensionWidgets(ui: extension, below: true),
      ],
    );
  }
}
