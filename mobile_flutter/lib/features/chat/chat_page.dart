import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/attachments.dart';
import '../../core/protocol.dart';
import '../../ui/glass_page.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../home/welcome_view.dart';
import '../mobile_controller.dart';
import 'attachments.dart';
import 'configuration.dart';
import 'run_details.dart';
import 'transcript.dart';
import 'transcript_rows.dart';
import 'workflow_panel.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    required this.controller,
    required this.onPickProject,
    required this.onPickAgent,
    required this.onSessions,
    required this.onSettings,
    this.home = false,
  });
  final MobileController controller;

  /// 首页模式：欢迎页即「草稿会话」，右上角为设置。
  final bool home;
  final VoidCallback onPickProject, onPickAgent, onSessions, onSettings;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final text = TextEditingController();
  final scroll = ScrollController();
  final FocusNode inputFocus = FocusNode();
  bool sending = false, commandsLoading = false;
  final attachments = <PendingAttachment>[];
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

  bool get uploading =>
      attachments.any((a) => a.status != AttachmentStatus.done);

  Future<void> send() async {
    if (sending || uploading) return;
    final draft = text.text;
    final sent = [...attachments];
    setState(() => sending = true);
    final ok = await c.send(
      draft,
      attachments: [for (final a in sent) a.uploadId!],
    );
    if (mounted) {
      setState(() {
        sending = false;
        if (ok && text.text == draft) text.clear();
        if (ok) attachments.removeWhere(sent.contains);
      });
    }
  }

  // ---- 附件 ----

  void toast(String message) => showNekoToast(context, message);

  void addFiles(List<PendingAttachment> picked) {
    final room = maxAttachments - attachments.length;
    if (picked.length > room) toast('一次最多添加 $maxAttachments 个附件');
    final accepted = <PendingAttachment>[];
    for (final file in picked.take(room < 0 ? 0 : room)) {
      if (file.size == 0) continue;
      if (file.size > maxAttachmentBytes) {
        toast('「${file.name}」超过 ${maxAttachmentBytes ~/ 1024 ~/ 1024} MB');
        continue;
      }
      accepted.add(file);
    }
    if (accepted.isEmpty) return;
    setState(() => attachments.addAll(accepted));
    for (final file in accepted) {
      unawaited(startUpload(file));
    }
  }

  Future<void> startUpload(PendingAttachment file) async {
    setState(() {
      file.status = AttachmentStatus.uploading;
      file.progress = 0;
      file.error = null;
    });
    try {
      final id = await c.upload(
        file,
        onProgress: (p) {
          if (mounted) setState(() => file.progress = p);
        },
      );
      if (!attachments.contains(file)) {
        unawaited(c.cancelUpload(id));
        return;
      }
      if (mounted) {
        setState(() {
          file.uploadId = id;
          file.status = AttachmentStatus.done;
        });
      }
    } catch (e) {
      if (!mounted || !attachments.contains(file)) return;
      setState(() {
        file.status = AttachmentStatus.failed;
        file.error = '$e';
      });
      toast('「${file.name}」上传失败：$e');
    }
  }

  void removeAttachment(PendingAttachment file) {
    setState(() => attachments.remove(file));
    final id = file.uploadId;
    if (id != null) unawaited(c.cancelUpload(id));
  }

  Future<void> pickPhotos() async {
    try {
      final room = maxAttachments - attachments.length;
      if (room <= 0) return toast('一次最多添加 $maxAttachments 个附件');
      final images = await ImagePicker().pickMultiImage(
        maxWidth: 2560,
        maxHeight: 2560,
        imageQuality: 85,
        limit: room > 1 ? room : null,
      );
      addFiles([
        for (final image in images)
          PendingAttachment(name: image.name, bytes: await image.readAsBytes()),
      ]);
    } catch (e) {
      toast('无法打开相册：$e');
    }
  }

  Future<void> takePhoto() async {
    try {
      final photo = await ImagePicker().pickImage(
        source: ImageSource.camera,
        maxWidth: 2560,
        maxHeight: 2560,
        imageQuality: 85,
      );
      if (photo == null) return;
      addFiles([
        PendingAttachment(name: photo.name, bytes: await photo.readAsBytes()),
      ]);
    } catch (e) {
      toast('无法打开相机：$e');
    }
  }

  Future<void> pickFiles() async {
    try {
      final files = await FilePicker.pickFiles();
      addFiles([
        for (final file in files)
          PendingAttachment(
            name: file.name,
            bytes: await file.xFile.readAsBytes(),
          ),
      ]);
    } catch (e) {
      toast('无法选择文件：$e');
    }
  }

  void openAttachMenu() {
    unawaited(
      showAttachSheet(context, [
        AttachAction(
          '相册',
          MiuixIcon(vector: MiuixIcons.os4.photos, size: 26),
          pickPhotos,
        ),
        AttachAction(
          '拍照',
          const Icon(Icons.photo_camera_outlined, size: 26),
          takePhoto,
        ),
        AttachAction(
          '文件',
          MiuixIcon(vector: MiuixIcons.os4.file, size: 26),
          pickFiles,
        ),
        if (!draft)
          AttachAction(
            '命令',
            const Text(
              '/',
              style: TextStyle(fontSize: 22, fontFamily: 'monospace'),
            ),
            commands,
          ),
      ]),
    );
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

  /// 草稿：尚未创建任务 / 外部代理会话。
  bool get draft => c.taskId == null && c.acpId == null;

  void suggest(String prompt) {
    text.text = prompt;
    text.selection = TextSelection.collapsed(offset: prompt.length);
    inputFocus.requestFocus();
    setState(() {});
  }

  String get homeSubtitle {
    final device = c.desktop.name.isEmpty ? '电脑' : c.desktop.name;
    final link = c.desktop.mode == 'relay' ? '公网' : '局域网';
    return '$device · $link · ${c.online ? '在线' : '离线'}';
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
        : '${cells.last['id']}:${cells.last['text']}:${cells.last['thinking']}:${cells.last['output']}';
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

    final welcome = draft && cells.isEmpty && c.snapshot?['streaming'] != true;
    return GlassPage(
      title: widget.home ? 'NekoCode' : title,
      subtitle: widget.home ? homeSubtitle : subtitle,
      pinnedSmallTitle: true,
      floatingActions: true,
      captureBackdrop: false,
      // The composer handles IME/safe-area padding itself. Keep scaffold
      // insets stable when the keyboard consumes the bottom system padding.
      contentWindowInsets: MediaQuery.viewPaddingOf(context),
      scrollController: scroll,
      navigationIcon: GlassAction(
        icon: MiuixIcons.os4.sidebar,
        tooltip: '会话列表',
        onPressed: widget.onSessions,
      ),
      actions: [
        if (widget.home)
          GlassAction(
            icon: MiuixIcons.os4.settings,
            tooltip: '设置',
            onPressed: widget.onSettings,
          )
        else
          GlassAction(
            icon: MiuixIcons.os4.add,
            tooltip: '新建会话',
            onPressed: () => c.navigate('tasks'),
          ),
      ],
      body: (context, scope) => Stack(
        children: [
          if (welcome)
            const Positioned.fill(
              child: RepaintBoundary(child: WelcomeBackdrop()),
            ),
          Column(
            children: [
              Expanded(
                child: RepaintBoundary(child: _messages(context, scope, cells)),
              ),
              _bottom(context, extension, running, blocked),
            ],
          ),
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
    final streaming = c.snapshot?['streaming'] == true;
    if (cells.isEmpty && !streaming && draft) {
      return Padding(
        padding: EdgeInsets.only(top: top),
        child: WelcomeView(
          controller: c,
          onPickProject: widget.onPickProject,
          onPickAgent: widget.onPickAgent,
          onSuggestion: suggest,
        ),
      );
    }
    if (cells.isEmpty && !streaming) {
      return Padding(
        padding: EdgeInsets.only(top: top),
        child: EmptyState(
          icon: MiuixIcons.os4.create,
          title: '有什么可以帮你？',
          summary: '描述你想完成的任务，NekoCode 会在电脑上读写代码、运行命令并汇报结果。',
        ),
      );
    }
    final items = transcriptRows(cells, streaming: streaming);
    final waiting = waitingOnModel(cells, streaming);
    final lastUser = items.lastIndexWhere((row) => row.kind == 'user');
    final planning = waiting && (items.isEmpty || items.last.kind != 'work');
    final more = c.desktop.more && !c.isAcp;
    return ListView.builder(
      controller: scroll,
      padding: EdgeInsets.only(top: top + 8, bottom: 12),
      itemCount: items.length + (more ? 1 : 0) + (planning ? 1 : 0),
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
        if (index == items.length) {
          return const Padding(
            padding: EdgeInsets.fromLTRB(16, 6, 16, 6),
            child: PlanningLine(),
          );
        }
        final item = items[index];
        if (item.kind == 'work') {
          return WorkingBlock(
            key: ValueKey(item.id),
            row: item,
            controller: c,
            active: streaming && index > lastUser,
            waiting: waiting && index == items.length - 1,
          );
        }
        return TranscriptItem(key: ValueKey(item.id), row: item, controller: c);
      },
    );
  }

  Widget _bottom(
    BuildContext context,
    Json extension,
    bool running,
    bool blocked,
  ) {
    // Keep the inset dependency out of ChatPage/GlassPage: IME animation
    // should update only this padding, without rebuilding the transcript.
    final content = RepaintBoundary(
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
          ValueListenableBuilder<TextEditingValue>(
            valueListenable: text,
            builder: (context, _, _) => _composer(context, running, blocked),
          ),
          ExtensionWidgets(ui: extension, below: true),
        ],
      ),
    );
    return Builder(
      builder: (context) {
        final keyboard = MediaQuery.viewInsetsOf(context).bottom;
        final safeBottom = MediaQuery.paddingOf(context).bottom;
        return Padding(
          padding: EdgeInsets.only(
            bottom: keyboard > 0 ? keyboard : safeBottom,
          ),
          child: content,
        );
      },
    );
  }

  Widget _composer(BuildContext context, bool running, bool blocked) {
    final mx = context.mx;
    final empty = text.text.trim().isEmpty && attachments.isEmpty;
    final canSend = !blocked && !empty && !uploading;
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
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (attachments.isNotEmpty)
                AttachmentTray(
                  items: attachments,
                  onRemove: removeAttachment,
                  onRetry: (file) => unawaited(startUpload(file)),
                ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  MiuixPressable(
                    onPressed: sending || commandsLoading
                        ? null
                        : openAttachMenu,
                    feedbackType: MiuixPressFeedbackType.sink,
                    semanticLabel: '添加附件',
                    child: Container(
                      width: 40,
                      height: 40,
                      alignment: Alignment.center,
                      child: MiuixIcon(
                        vector: MiuixIcons.os4.add,
                        size: 22,
                        tint: mx.onSurfaceVariantSummary,
                      ),
                    ),
                  ),
                  Expanded(
                    child: MiuixTextField(
                      controller: text,
                      focusNode: inputFocus,
                      label: draft ? '描述任务，开始新会话' : '发消息',
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
            ],
          ),
        ),
      ),
    );
  }
}
