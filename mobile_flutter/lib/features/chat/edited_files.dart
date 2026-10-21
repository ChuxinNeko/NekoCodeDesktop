import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';
import 'file_changes.dart';
import 'tool_result.dart';
import 'workflow_style.dart';

/// Same green/red pair as desktop DiffStat, with bounded live updates.
class DiffStat extends StatelessWidget {
  const DiffStat({super.key, required this.additions, required this.deletions});
  final int additions, deletions;
  @override
  Widget build(BuildContext context) => Semantics(
    label: '新增 $additions 行，删除 $deletions 行',
    child: ExcludeSemantics(
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            '+$additions',
            style: WorkflowStyle.text(context, 11).copyWith(
              color: NekoTone.success(context.isDark),
              fontFamily: 'monospace',
            ),
          ),
          const SizedBox(width: 5),
          Text(
            '−$deletions',
            style: WorkflowStyle.text(
              context,
              11,
            ).copyWith(color: context.mx.error, fontFamily: 'monospace'),
          ),
        ],
      ),
    ),
  );
}

/// Floating composer capsule while live; scrolls with its originating turn after.
class EditedFilesCapsule extends StatelessWidget {
  const EditedFilesCapsule({
    super.key,
    required this.changes,
    required this.controller,
    this.live = false,
  });
  final TurnChanges changes;
  final MobileController controller;
  final bool live;
  @override
  Widget build(BuildContext context) {
    if (changes.files.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Align(
        alignment: Alignment.center,
        child: MiuixPressable(
          semanticLabel: '查看 ${changes.files.length} 个文件的变更',
          onPressed: () => showNekoSheet<void>(
            context,
            title: '文件变更',
            subtitle: '${changes.files.length} 个文件 · ${live ? '实时变更' : '本轮变更'}',
            builder: (_) => _ChangedFilesList(
              changes: changes,
              controller: controller,
              taskId: controller.taskId,
            ),
          ),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
            decoration: BoxDecoration(
              color: context.mx.surfaceContainer,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: context.mx.dividerLine),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(
                  child: Text(
                    '${changes.files.length} 个文件已修改',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: WorkflowStyle.text(context),
                  ),
                ),
                const SizedBox(width: 8),
                DiffStat(
                  additions: changes.additions,
                  deletions: changes.deletions,
                ),
                const SizedBox(width: 6),
                const WorkflowChevron(open: false, size: 12),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ChangedFilesList extends StatefulWidget {
  const _ChangedFilesList({
    required this.changes,
    required this.controller,
    required this.taskId,
  });
  final String? taskId;
  final TurnChanges changes;
  final MobileController controller;
  @override
  State<_ChangedFilesList> createState() => _ChangedFilesListState();
}

class _ChangedFilesListState extends State<_ChangedFilesList> {
  String? selected;
  @override
  Widget build(BuildContext context) {
    if (selected != null) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: ActionButton(
                '返回文件列表',
                compact: true,
                onPressed: () => setState(() => selected = null),
              ),
            ),
          ),
          Flexible(
            child: FileDiffDetails(
              key: ValueKey('${widget.changes.checkpointId}:$selected'),
              taskId: widget.taskId,
              checkpointId: widget.changes.checkpointId,
              path: selected!,
              controller: widget.controller,
            ),
          ),
        ],
      );
    }
    return ListView(
      shrinkWrap: true,
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
      children: [
        for (final file in widget.changes.files)
          MiuixPressable(
            semanticLabel: '查看 ${file.path} 的差异',
            onPressed: () => setState(() => selected = file.path),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      file.path.replaceAll('\\', '/'),
                      style: WorkflowStyle.text(context),
                      softWrap: true,
                    ),
                  ),
                  const SizedBox(width: 12),
                  DiffStat(
                    additions: file.additions,
                    deletions: file.deletions,
                  ),
                  const SizedBox(width: 8),
                  const WorkflowChevron(open: false),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// Read-only, checkpoint-scoped and paged over the same LAN/relay transport.
class FileDiffDetails extends StatefulWidget {
  const FileDiffDetails({
    super.key,
    required this.taskId,
    required this.checkpointId,
    required this.path,
    required this.controller,
  });
  final String? taskId;
  final String checkpointId, path;
  final MobileController controller;
  @override
  State<FileDiffDetails> createState() => _FileDiffDetailsState();
}

class _FileDiffDetailsState extends State<FileDiffDetails> {
  String patch = '', version = '';
  String? error;
  bool loading = false, binary = false, loaded = false;
  int total = 0;
  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load({bool more = false}) async {
    if (loading) return;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      if (widget.taskId == null || widget.checkpointId.isEmpty) {
        throw ApiError('该会话没有可用的文件检查点');
      }
      final value = object(
        await widget.controller.desktop.request(
          '/api/tasks/${Uri.encodeComponent(widget.taskId!)}/checkpoint-diff',
          {
            'checkpointId': widget.checkpointId,
            'path': widget.path,
            'offset': more ? patch.length : 0,
            if (more) 'version': version,
          },
        ),
      );
      if (!mounted) return;
      if (value['path'] != widget.path ||
          value['offset'] is! num ||
          value['total'] is! num) {
        throw ApiError('电脑返回了无法识别的差异数据');
      }
      final offset = (value['offset'] as num).toInt();
      if (offset != 0 &&
          (offset != patch.length || value['version'] != version)) {
        throw ApiError('文件差异已变化，请重新加载');
      }
      setState(() {
        patch = (offset == 0 ? '' : patch) + string(value['patch']);
        version = string(value['version']);
        total = (value['total'] as num).toInt();
        binary = value['binary'] == true;
        loading = false;
        loaded = true;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          error = e is ApiError && e.status == 404
              ? '电脑端暂不支持差异详情，或检查点已失效。请更新并重启电脑端后重试。'
              : '$e';
          loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    padding: const EdgeInsets.only(bottom: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: SelectableText(
            widget.path,
            style: WorkflowStyle.text(context, 12),
          ),
        ),
        if (loaded && !binary && patch.isNotEmpty) DiffView(text: patch),
        if (loaded && (binary || patch.isEmpty))
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              binary ? '二进制文件，不提供文本差异预览。' : '此文件目前没有文本差异。',
              style: WorkflowStyle.text(context),
            ),
          ),
        if (error != null) ErrorNotice(error),
        if (loading)
          const Padding(
            padding: EdgeInsets.all(16),
            child: Center(child: MiuixInfiniteProgressIndicator(size: 18)),
          ),
        if (!loading && error != null)
          Center(
            child: ActionButton('重试', compact: true, onPressed: () => load()),
          ),
        if (!loading && error == null && patch.length < total)
          Center(
            child: ActionButton(
              '加载更多差异',
              compact: true,
              onPressed: () => load(more: true),
            ),
          ),
      ],
    ),
  );
}
