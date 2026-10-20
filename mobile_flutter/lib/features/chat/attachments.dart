import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/attachments.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';

/// 「+」菜单里的一项。
class AttachAction {
  const AttachAction(this.label, this.icon, this.onTap);
  final String label;
  final Widget icon;
  final VoidCallback onTap;
}

/// 输入框左侧「+」弹出的附件面板：相册 / 拍照 / 文件 / 斜杠命令。
Future<void> showAttachSheet(
  BuildContext context,
  List<AttachAction> actions,
) => showNekoSheet<void>(
  context,
  title: '添加附件',
  subtitle: '图片会直接交给模型，其他文件会保存到电脑上的项目中',
  builder: (ctx) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
    child: Row(
      mainAxisAlignment: MainAxisAlignment.spaceAround,
      children: [
        for (final action in actions)
          Expanded(
            child: MiuixPressable(
              onPressed: () {
                Navigator.pop(ctx);
                action.onTap();
              },
              feedbackType: MiuixPressFeedbackType.sink,
              semanticLabel: action.label,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    width: 44,
                    height: 44,
                    child: Center(
                      child: MiuixContentColor(
                        color: ctx.mx.onSurface,
                        child: IconTheme(
                          data: IconThemeData(
                            color: ctx.mx.onSurface,
                            size: 26,
                          ),
                          child: DefaultTextStyle.merge(
                            style: TextStyle(color: ctx.mx.onSurface),
                            child: action.icon,
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 4),
                  MiuixText(action.label, fontSize: 13),
                ],
              ),
            ),
          ),
      ],
    ),
  ),
);

/// 输入框上方的附件条：图片显示缩略图，其他文件显示名称与大小。
class AttachmentTray extends StatelessWidget {
  const AttachmentTray({
    super.key,
    required this.items,
    required this.onRemove,
    required this.onRetry,
  });
  final List<PendingAttachment> items;
  final ValueChanged<PendingAttachment> onRemove, onRetry;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 72,
    child: ListView.separated(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(6, 6, 6, 2),
      itemCount: items.length,
      separatorBuilder: (_, _) => const SizedBox(width: 8),
      itemBuilder: (context, i) => _AttachmentChip(
        key: ValueKey(items[i].key),
        item: items[i],
        onRemove: () => onRemove(items[i]),
        onRetry: () => onRetry(items[i]),
      ),
    ),
  );
}

class _AttachmentChip extends StatelessWidget {
  const _AttachmentChip({
    super.key,
    required this.item,
    required this.onRemove,
    required this.onRetry,
  });
  final PendingAttachment item;
  final VoidCallback onRemove, onRetry;

  @override
  Widget build(BuildContext context) {
    final mx = context.mx;
    final failed = item.status == AttachmentStatus.failed;
    final uploading = item.status == AttachmentStatus.uploading;
    final shape = NekoShape.squircle(16);
    final Widget body = item.isImage
        ? SizedBox(
            width: 62,
            height: 62,
            child: ClipPath(
              clipper: ShapeBorderClipper(shape: shape),
              child: Image.memory(
                item.bytes,
                fit: BoxFit.cover,
                cacheWidth: 186,
                gaplessPlayback: true,
                errorBuilder: (_, _, _) => ColoredBox(
                  color: mx.surfaceContainerHigh,
                  child: Icon(
                    Icons.image_outlined,
                    color: mx.onSurfaceVariantSummary,
                  ),
                ),
              ),
            ),
          )
        : Container(
            height: 62,
            constraints: const BoxConstraints(maxWidth: 190),
            padding: const EdgeInsets.fromLTRB(10, 8, 14, 8),
            decoration: ShapeDecoration(
              color: mx.surfaceContainerHigh,
              shape: shape,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                MiuixIcon(
                  vector: MiuixIcons.os4.file,
                  size: 20,
                  tint: mx.onSurfaceVariantSummary,
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      MiuixText(
                        item.name,
                        fontSize: 13,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      MiuixText(
                        failed ? '上传失败，点按重试' : formatBytes(item.size),
                        fontSize: 11.5,
                        color: failed ? mx.error : mx.onSurfaceVariantSummary,
                        maxLines: 1,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          );

    return Stack(
      clipBehavior: Clip.none,
      children: [
        MiuixPressable(
          onPressed: failed ? onRetry : null,
          semanticLabel: failed ? '重试上传 ${item.name}' : item.name,
          child: Stack(
            alignment: Alignment.center,
            children: [
              body,
              if (uploading || (failed && item.isImage))
                Positioned.fill(
                  child: DecoratedBox(
                    decoration: ShapeDecoration(
                      color: Colors.black.withValues(alpha: .38),
                      shape: shape,
                    ),
                    child: Center(
                      child: failed
                          ? const Icon(
                              Icons.refresh_rounded,
                              color: Colors.white,
                              size: 24,
                            )
                          : SizedBox(
                              width: 24,
                              height: 24,
                              child: CircularProgressIndicator(
                                value: item.progress > 0 ? item.progress : null,
                                strokeWidth: 2.4,
                                color: Colors.white,
                                backgroundColor: Colors.white24,
                              ),
                            ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        Positioned(
          top: -5,
          right: -5,
          child: MiuixPressable(
            onPressed: onRemove,
            semanticLabel: '移除 ${item.name}',
            child: Container(
              width: 22,
              height: 22,
              decoration: BoxDecoration(
                color: mx.onSurface.withValues(alpha: .78),
                shape: BoxShape.circle,
                border: Border.all(color: mx.surfaceContainer, width: 2),
              ),
              alignment: Alignment.center,
              child: Icon(
                Icons.close_rounded,
                size: 13,
                color: mx.surfaceContainer,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
