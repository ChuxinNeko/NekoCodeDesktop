import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/glass_page.dart';
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
    required this.onBack,
  });
  final MobileController controller;
  final VoidCallback onPickProject, onBack;

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
      final command = await showNekoSheet<String>(
        context,
        title: '斜杠命令',
        subtitle: '选择后会填入输入框',
        builder: (ctx) {
          final mx = ctx.mx;
          if (values.isEmpty) {
            return const Padding(
              padding: EdgeInsets.fromLTRB(24, 8, 24, 36),
              child: MiuixText('当前会话暂无可用命令', fontSize: 14),
            );
          }
          return ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.only(bottom: 16),
            children: [
              for (final v in values)
                MiuixBasicComponent(
                  insideMargin: const EdgeInsets.symmetric(
                    horizontal: 24,
                    vertical: 12,
                  ),
                  content: [
                    MiuixText(
                      '/${v['name']}',
                      fontSize: 15.5,
                      fontFamily: 'monospace',
                      fontWeight: FontWeight.w600,
                      color: mx.primary,
                    ),
                    if (string(v['description']).isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: MiuixText(
                          string(v['description']),
                          fontSize: 13.5,
                          color: mx.onSurfaceVariantSummary,
                        ),
                      ),
                  ],
                  onClick: () => Navigator.pop(ctx, '/${v['name']} '),
                ),
            ],
          );
        },
      );
      if (command != null && mounted) {
        text.text = command;
        text.selection = TextSelection.collapsed(offset: text.text.length);
        inputFocus.requestFocus();
      }
    } catch (e) {
      c.error = '$e';
      c.emit();
    } finally {
      if (mounted) setState(() => commandsLoading = false);
    }
  }

  String get projectLabel {
    final cwd = string(
      object(c.snapshot?['session'])['cwd'],
      string(c.snapshot?['cwd'], string(c.project?['path'])),
    );
    final name = cwd
        .split(RegExp(r'[/\\]'))
        .where((s) => s.isNotEmpty)
        .lastOrNull;
    return name ?? string(c.project?['name'], '未选择项目');
  }

  String get subtitle {
    final device = c.desktop.name.isNotEmpty ? c.desktop.name : '电脑';
    final usage = object(c.snapshot?['context']);
    String k(dynamic v) => v is num && v >= 1000
        ? '${(v / 1000).toStringAsFixed(v >= 100000 ? 0 : 1)}k'
        : '${v ?? 0}';
    return [
      device,
      projectLabel,
      if (usage['used'] != null) '${k(usage['used'])} / ${k(usage['window'])}',
    ].join(' · ');
  }

  /// 把连续的工具调用合并成一组。
  List<Object> displayItems(List<Json> cells) {
    final out = <Object>[];
    for (final cell in cells) {
      if (cell['type'] == 'tool') {
        if (out.isNotEmpty && out.last is List<Json>) {
          (out.last as List<Json>).add(cell);
        } else {
          out.add(<Json>[cell]);
        }
      } else {
        out.add(cell);
      }
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
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
    final title = string(
      c.snapshot?['title'],
      c.taskId != null || c.acpId != null ? '当前任务' : '新会话',
    );

    return GlassPage(
      title: title,
      subtitle: subtitle,
      pinnedSmallTitle: true,
      scrollController: scroll,
      navigationIcon: GlassAction(
        icon: MiuixIcons.os4.chevronBackward,
        tooltip: '返回会话列表',
        onPressed: widget.onBack,
      ),
      actions: [
        GlassAction(
          icon: MiuixIcons.os4.add,
          tooltip: '新建会话',
          onPressed: c.busy || !c.online ? null : widget.onPickProject,
        ),
      ],
      body: (context, scope) => Column(
        children: [
          Expanded(child: _messages(context, scope, cells)),
          _bottom(context, extension, running, blocked),
        ],
      ),
    );
  }

  Widget _messages(BuildContext context, GlassScope scope, List<Json> cells) {
    final top = scope.padding.top;
    if (c.snapshot == null && (c.taskId != null || c.acpId != null)) {
      return Padding(
        padding: EdgeInsets.only(top: top),
        child: Center(
          child: MiuixInfiniteProgressIndicator(
            color: context.mx.primary,
            size: 28,
            strokeWidth: 3,
          ),
        ),
      );
    }
    if (cells.isEmpty) {
      return Padding(
        padding: EdgeInsets.only(top: top),
        child: EmptyState(
          icon: MiuixIcons.os4.create,
          title: '有什么可以帮你？',
          summary: '描述你想完成的任务，NekoCode 会在电脑上读写代码、运行命令并汇报结果。',
        ),
      );
    }
    final items = displayItems(cells);
    final more = c.desktop.more && !c.isAcp;
    return ListView.builder(
      controller: scroll,
      padding: EdgeInsets.only(top: top + 8, bottom: 12),
      itemCount: items.length + (more ? 1 : 0),
      itemBuilder: (_, index) {
        if (more) {
          if (index == 0) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: ActionButton(
                  c.loadingEarlier ? '加载中…' : '查看更早历史',
                  compact: true,
                  onPressed: c.loadingEarlier
                      ? null
                      : () async {
                          final before = scroll.position.maxScrollExtent;
                          final offset = scroll.offset;
                          await c.earlier();
                          WidgetsBinding.instance.addPostFrameCallback((_) {
                            if (mounted && scroll.hasClients) {
                              scroll.jumpTo(
                                (offset +
                                        scroll.position.maxScrollExtent -
                                        before)
                                    .clamp(0, scroll.position.maxScrollExtent),
                              );
                            }
                          });
                        },
                ),
              ),
            );
          }
          index--;
        }
        final item = items[index];
        if (item is List<Json>) {
          return ToolGroup(
            key: ValueKey('tools:${item.first['id']}'),
            cells: item,
            controller: c,
          );
        }
        final cell = item as Json;
        return MessageCell(
          key: ValueKey(cell['id']),
          cell: cell,
          controller: c,
        );
      },
    );
  }

  Widget _bottom(
    BuildContext context,
    Json extension,
    bool running,
    bool blocked,
  ) {
    final media = MediaQuery.of(context);
    final bottomInset = media.viewInsets.bottom > 0
        ? media.viewInsets.bottom
        : media.padding.bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: bottomInset),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ErrorNotice(
            c.error,
            onDismiss: () {
              c.error = null;
              c.emit();
            },
          ),
          if (c.snapshot?['error'] != null && c.snapshot?['error'] != c.error)
            ErrorNotice(string(c.snapshot?['error'])),
          WorkflowPanel(controller: c),
          ExtensionWidgets(
            ui: extension,
            below: false,
            onAnswer: c.answerExtension,
            streaming: c.snapshot?['streaming'] == true,
          ),
          ConfigurationBar(controller: c),
          _composer(context, running, blocked),
          ExtensionWidgets(ui: extension, below: true),
        ],
      ),
    );
  }

  Widget _composer(BuildContext context, bool running, bool blocked) {
    final mx = context.mx;
    final empty = text.text.trim().isEmpty;
    final canSend = !blocked && !empty;
    final Color fill = running
        ? mx.error
        : canSend
        ? mx.primary
        : mx.surfaceContainerHigh;
    final Color fg = running || canSend
        ? Colors.white
        : mx.onSurfaceVariantActions;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 2, 12, 10),
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: mx.surfaceContainer,
          shape: NekoShape.squircle(28),
          shadows: [
            BoxShadow(
              color: Colors.black.withValues(alpha: context.isDark ? .35 : .07),
              blurRadius: 24,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(6, 6, 6, 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              MiuixPressable(
                onPressed: commandsLoading ? null : commands,
                feedbackType: MiuixPressFeedbackType.sink,
                semanticLabel: '斜杠命令',
                child: Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: mx.primary.withValues(alpha: .1),
                    shape: BoxShape.circle,
                  ),
                  alignment: Alignment.center,
                  child: MiuixText(
                    '/',
                    fontSize: 20,
                    fontWeight: FontWeight.w600,
                    fontFamily: 'monospace',
                    color: mx.primary,
                  ),
                ),
              ),
              Expanded(
                child: MiuixTextField(
                  controller: text,
                  focusNode: inputFocus,
                  label: '发消息，或输入 / 使用命令',
                  useLabelAsPlaceholder: true,
                  cornerRadius: 20,
                  insideMargin: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                  enabled: !sending,
                  maxLines: 6,
                  minLines: 1,
                  textStyle: TextStyle(
                    fontSize: 16,
                    height: 1.35,
                    color: mx.onSurface,
                  ),
                  colors: MiuixTextFieldColors(
                    backgroundColor: Colors.transparent,
                    labelColor: mx.onSurfaceVariantActions,
                    borderColor: Colors.transparent,
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ),
              MiuixPressable(
                onPressed: running
                    ? (c.busy ? null : c.abort)
                    : (canSend ? send : null),
                feedbackType: MiuixPressFeedbackType.sink,
                semanticLabel: running ? '停止' : '发送',
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 160),
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: fill,
                    shape: BoxShape.circle,
                  ),
                  alignment: Alignment.center,
                  child: running
                      ? Icon(Icons.stop_rounded, size: 22, color: fg)
                      : MiuixIcon(
                          vector: MiuixIcons.os4.send,
                          size: 22,
                          tint: fg,
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
