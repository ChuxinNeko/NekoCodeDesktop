import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_miuix/miuix.dart';

import 'theme.dart';

/// 通用按钮。主操作使用 [isPrimary]（品牌蓝），危险操作使用 [danger]。
class ActionButton extends StatelessWidget {
  const ActionButton(
    this.label, {
    super.key,
    required this.onPressed,
    this.icon,
    this.isPrimary = false,
    this.danger = false,
    this.expand = false,
    this.compact = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool isPrimary, danger, expand, compact;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    final colors = danger
        ? MiuixButtonColors(
            color: c.error.withValues(alpha: .12),
            disabledColor: c.secondaryContainer,
            contentColor: c.error,
            disabledContentColor: c.disabledOnSecondaryVariant,
          )
        : isPrimary
        ? MiuixButtonDefaults.buttonColorsPrimary(context)
        : MiuixButtonDefaults.buttonColors(context);
    final button = MiuixButton(
      onPressed: onPressed,
      enabled: onPressed != null,
      colors: colors,
      cornerRadius: compact ? 14 : 18,
      minHeight: compact ? 34 : 48,
      minWidth: compact ? 0 : 64,
      insideMargin: EdgeInsets.symmetric(
        horizontal: compact ? 14 : 20,
        vertical: compact ? 6 : 12,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (icon != null) ...[Icon(icon, size: 18), const SizedBox(width: 6)],
          Flexible(
            child: MiuixText(
              label,
              fontSize: compact ? 14 : 16,
              fontWeight: FontWeight.w600,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
    return expand ? SizedBox(width: double.infinity, child: button) : button;
  }
}

/// 折叠头：图标 + 动词 + 对象 + 展开箭头。用于推理、工具调用等可折叠条目。
class StepHeader extends StatelessWidget {
  const StepHeader({
    super.key,
    required this.verb,
    this.object = '',
    this.detail,
    this.running = false,
    this.expanded = false,
    this.onToggle,
    this.icon,
    this.trailing,
    this.mono = false,
  });

  final String verb, object;
  final String? detail;
  final bool running, expanded, mono;
  final VoidCallback? onToggle;
  final Widget? icon, trailing;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    return MiuixPressable(
      onPressed: onToggle,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: Row(
          children: [
            SizedBox(
              width: 20,
              height: 20,
              child: Center(
                child: running
                    ? MiuixInfiniteProgressIndicator(
                        color: c.primary,
                        size: 18,
                        strokeWidth: 2,
                      )
                    : icon,
              ),
            ),
            const SizedBox(width: 10),
            MiuixText(verb, fontSize: 14, fontWeight: FontWeight.w600),
            if (object.isNotEmpty) ...[
              const SizedBox(width: 8),
              Expanded(
                child: MiuixText(
                  object,
                  fontSize: 13,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  color: c.onSurfaceVariantSummary,
                  fontFamily: mono ? 'monospace' : null,
                ),
              ),
            ] else
              const Spacer(),
            if (detail != null && detail!.isNotEmpty) ...[
              const SizedBox(width: 8),
              MiuixText(
                detail!,
                fontSize: 12,
                color: c.onSurfaceVariantActions,
              ),
            ],
            if (trailing != null) ...[const SizedBox(width: 8), trailing!],
            if (onToggle != null) ...[
              const SizedBox(width: 6),
              AnimatedRotation(
                turns: expanded ? .25 : 0,
                duration: const Duration(milliseconds: 180),
                child: MiuixIcon(
                  vector: MiuixIcons.os4.chevronForward,
                  size: 18,
                  tint: c.onSurfaceVariantActions,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 终端 / 代码输出视窗。
class StepOutputCard extends StatelessWidget {
  const StepOutputCard({
    super.key,
    required this.output,
    this.title,
    this.maxHeight = 240,
    this.margin = const EdgeInsets.fromLTRB(10, 0, 10, 10),
  });

  final String output;
  final String? title;
  final double maxHeight;
  final EdgeInsetsGeometry margin;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    final dark = context.isDark;
    return Padding(
      padding: margin,
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: NekoTone.codeBackground(dark),
          shape: NekoShape.squircle(14),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 6, 0),
              child: Row(
                children: [
                  Expanded(
                    child: MiuixText(
                      title ?? '输出',
                      fontSize: 11,
                      color: c.onSurfaceVariantActions,
                    ),
                  ),
                  MiuixPressable(
                    onPressed: () {
                      Clipboard.setData(ClipboardData(text: output));
                      showNekoToast(context, '已复制到剪贴板');
                    },
                    child: Padding(
                      padding: const EdgeInsets.all(8),
                      child: MiuixIcon(
                        vector: MiuixIcons.os4.copy,
                        size: 16,
                        tint: c.onSurfaceVariantActions,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: maxHeight),
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
                child: SelectableText(
                  output,
                  style: TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12,
                    height: 1.5,
                    color: c.onSurfaceSecondary,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 胶囊标签。带 [onTap] 时右侧显示下拉箭头。
class PillBadge extends StatelessWidget {
  const PillBadge({
    super.key,
    required this.label,
    this.icon,
    this.dotColor,
    this.onTap,
    this.selected = false,
  });

  final String label;
  final IconData? icon;
  final Color? dotColor;
  final VoidCallback? onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    final fg = selected ? c.primary : c.onSurfaceSecondary;
    final body = DecoratedBox(
      decoration: ShapeDecoration(
        color: selected
            ? c.primary.withValues(alpha: .12)
            : c.surfaceContainerHigh.withValues(
                alpha: context.isDark ? .9 : .7,
              ),
        shape: const StadiumBorder(),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (dotColor != null) ...[
              StatusDot(color: dotColor!),
              const SizedBox(width: 6),
            ],
            if (icon != null) ...[
              Icon(icon, size: 14, color: fg),
              const SizedBox(width: 4),
            ],
            MiuixText(
              label,
              fontSize: 13,
              color: fg,
              fontWeight: FontWeight.w500,
            ),
            if (onTap != null) ...[
              const SizedBox(width: 2),
              RotatedBox(
                quarterTurns: 1,
                child: MiuixIcon(
                  vector: MiuixIcons.os4.chevronForward,
                  size: 12,
                  tint: c.onSurfaceVariantActions,
                ),
              ),
            ],
          ],
        ),
      ),
    );
    return onTap == null ? body : MiuixPressable(onPressed: onTap, child: body);
  }
}

class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.color, this.size = 8});
  final Color color;
  final double size;
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}

/// 错误 / 提示横幅。
class ErrorNotice extends StatelessWidget {
  const ErrorNotice(this.message, {super.key, this.onDismiss, this.margin});
  final String? message;
  final VoidCallback? onDismiss;
  final EdgeInsetsGeometry? margin;

  @override
  Widget build(BuildContext context) {
    if (message == null || message!.isEmpty) return const SizedBox.shrink();
    final c = context.mx;
    return Padding(
      padding:
          margin ??
          const EdgeInsets.symmetric(horizontal: NekoGap.page, vertical: 6),
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: c.error.withValues(alpha: .1),
          shape: NekoShape.squircle(16),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: MiuixIcon(
                  vector: MiuixIcons.os4.info,
                  size: 18,
                  tint: c.error,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: SelectableText(
                  message!,
                  style: TextStyle(fontSize: 14, height: 1.4, color: c.error),
                ),
              ),
              if (onDismiss != null)
                MiuixPressable(
                  onPressed: onDismiss,
                  child: Padding(
                    padding: const EdgeInsets.all(4),
                    child: MiuixIcon(
                      vector: MiuixIcons.os4.close,
                      size: 18,
                      tint: c.error,
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

/// 文本输入框（Miuix 浮动标签样式）。
Widget input(
  String label,
  TextEditingController controller, {
  bool secret = false,
  TextInputType? keyboard,
  int? maxLength,
  bool enabled = true,
  String? hint,
  TextInputAction? action,
}) => Padding(
  padding: const EdgeInsets.symmetric(vertical: 6),
  child: MiuixTextField(
    controller: controller,
    label: label,
    obscureText: secret,
    enabled: enabled,
    singleLine: true,
    keyboardType: keyboard,
    textInputAction: action,
    insideMargin: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
    onChanged: maxLength == null
        ? null
        : (value) {
            if (value.length > maxLength) {
              controller.value = TextEditingValue(
                text: value.substring(0, maxLength),
                selection: TextSelection.collapsed(offset: maxLength),
              );
            }
          },
  ),
);

// ---------------------------------------------------------------------------
// 分组列表（设置 / 会话列表共用）
// ---------------------------------------------------------------------------

/// 带小标题的圆角分组卡片，行之间自动补发丝分隔线。
class NekoGroup extends StatelessWidget {
  const NekoGroup({
    super.key,
    this.title,
    required this.children,
    this.footer,
    this.dividers = true,
  });

  final String? title, footer;
  final List<Widget> children;
  final bool dividers;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null)
          MiuixSmallTitle(
            title!,
            insideMargin: const EdgeInsets.fromLTRB(28, 14, 28, 8),
          ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: NekoGap.page),
          child: MiuixCard(
            cornerRadius: NekoShape.card,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var i = 0; i < children.length; i++) ...[
                  if (i > 0 && dividers)
                    Padding(
                      padding: const EdgeInsets.only(left: 16),
                      child: ColoredBox(
                        color: c.dividerLine.withValues(alpha: .6),
                        child: const SizedBox(height: .5),
                      ),
                    ),
                  children[i],
                ],
              ],
            ),
          ),
        ),
        if (footer != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 8, 28, 4),
            child: MiuixText(
              footer!,
              fontSize: 12.5,
              height: 1.45,
              color: c.onBackgroundVariant,
            ),
          ),
      ],
    );
  }
}

/// 彩色圆角图标块（HyperOS 设置页风格）。
class IconTile extends StatelessWidget {
  const IconTile({
    super.key,
    required this.icon,
    this.color,
    this.size = 36,
    this.soft = false,
  });
  final MiuixVectorIcon icon;
  final Color? color;
  final double size;

  /// 柔和样式：淡色底 + 彩色图标；否则为实心底 + 白色图标。
  final bool soft;
  @override
  Widget build(BuildContext context) {
    final tone = color ?? context.mx.primary;
    final bg = soft ? tone.withValues(alpha: .13) : tone;
    return Container(
      width: size,
      height: size,
      decoration: ShapeDecoration(
        color: bg,
        shape: NekoShape.squircle(size * .32),
      ),
      alignment: Alignment.center,
      child: MiuixIcon(
        vector: icon,
        size: size * .62,
        tint: soft ? tone : Colors.white,
      ),
    );
  }
}

/// 居中空状态。
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.summary,
    this.action,
  });
  final MiuixVectorIcon icon;
  final String title;
  final String? summary;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 48),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: ShapeDecoration(
                color: c.primary.withValues(alpha: .1),
                shape: NekoShape.squircle(24),
              ),
              alignment: Alignment.center,
              child: MiuixIcon(vector: icon, size: 38, tint: c.primary),
            ),
            const SizedBox(height: 20),
            MiuixText(
              title,
              fontSize: 18,
              fontWeight: FontWeight.w600,
              textAlign: TextAlign.center,
            ),
            if (summary != null) ...[
              const SizedBox(height: 8),
              MiuixText(
                summary!,
                fontSize: 14,
                height: 1.5,
                textAlign: TextAlign.center,
                color: c.onSurfaceVariantSummary,
              ),
            ],
            if (action != null) ...[const SizedBox(height: 24), action!],
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 浮层：Toast / 底部面板 / 确认对话框 / 选择器
// ---------------------------------------------------------------------------

/// 轻量提示（替代 SnackBar；本应用没有 Material Scaffold）。
void showNekoToast(BuildContext context, String message) {
  final overlay = Overlay.maybeOf(context, rootOverlay: true);
  if (overlay == null) return;
  final c = context.mx;
  late final OverlayEntry entry;
  entry = OverlayEntry(
    builder: (ctx) => Positioned(
      left: 24,
      right: 24,
      bottom: MediaQuery.viewPaddingOf(ctx).bottom + 96,
      child: IgnorePointer(
        child: _ToastBody(
          message: message,
          background: c.surfaceContainerHighest,
          foreground: c.onSurface,
          onDone: () => entry.remove(),
        ),
      ),
    ),
  );
  overlay.insert(entry);
}

class _ToastBody extends StatefulWidget {
  const _ToastBody({
    required this.message,
    required this.background,
    required this.foreground,
    required this.onDone,
  });
  final String message;
  final Color background, foreground;
  final VoidCallback onDone;
  @override
  State<_ToastBody> createState() => _ToastBodyState();
}

class _ToastBodyState extends State<_ToastBody> {
  double opacity = 0;
  Timer? timer;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => opacity = 1);
    });
    timer = Timer(const Duration(milliseconds: 1600), () {
      if (mounted) setState(() => opacity = 0);
      Timer(const Duration(milliseconds: 220), widget.onDone);
    });
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Center(
    child: AnimatedOpacity(
      opacity: opacity,
      duration: const Duration(milliseconds: 200),
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: widget.background,
          shape: const StadiumBorder(),
          shadows: const [
            BoxShadow(
              color: Color(0x26000000),
              blurRadius: 24,
              offset: Offset(0, 8),
            ),
          ],
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          child: DefaultTextStyle(
            style: TextStyle(fontSize: 14, color: widget.foreground),
            child: Text(widget.message),
          ),
        ),
      ),
    ),
  );
}

/// 浮动底部面板（四周留白的大圆角卡片）。
Future<T?> showNekoSheet<T>(
  BuildContext context, {
  String? title,
  String? subtitle,
  required WidgetBuilder builder,
  double maxHeightFactor = .72,
}) => showModalBottomSheet<T>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  backgroundColor: Colors.transparent,
  elevation: 0,
  barrierColor: context.mx.windowDimming,
  builder: (ctx) {
    final c = ctx.mx;
    final media = MediaQuery.of(ctx);
    return Padding(
      padding: EdgeInsets.fromLTRB(
        NekoGap.page,
        0,
        NekoGap.page,
        NekoGap.page + media.viewInsets.bottom,
      ),
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: c.surfaceContainer,
          shape: NekoShape.squircle(32),
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight:
                (media.size.height - media.viewInsets.bottom) * maxHeightFactor,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  margin: const EdgeInsets.only(top: 10, bottom: 6),
                  width: 36,
                  height: 4,
                  decoration: BoxDecoration(
                    color: c.outline,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              if (title != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 8, 24, 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      MiuixText(
                        title,
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 4),
                        MiuixText(
                          subtitle,
                          fontSize: 13.5,
                          color: c.onSurfaceVariantSummary,
                        ),
                      ],
                    ],
                  ),
                ),
              Flexible(child: builder(ctx)),
            ],
          ),
        ),
      ),
    );
  },
);

/// 选择器里的一项。
class NekoChoice<T> {
  const NekoChoice(this.value, this.label, {this.group, this.summary});
  final T value;
  final String label;
  final String? group, summary;
}

/// 单选列表面板；选中项右侧显示对勾。
Future<T?> showNekoPicker<T>(
  BuildContext context, {
  required String title,
  required List<NekoChoice<T>> choices,
  T? selected,
}) => showNekoSheet<T>(
  context,
  title: title,
  builder: (ctx) {
    final c = ctx.mx;
    String? group;
    final rows = <Widget>[];
    for (final choice in choices) {
      if (choice.group != null && choice.group != group) {
        group = choice.group;
        rows.add(
          MiuixSmallTitle(
            group!,
            insideMargin: const EdgeInsets.fromLTRB(24, 12, 24, 6),
          ),
        );
      }
      final on = choice.value == selected;
      rows.add(
        MiuixBasicComponent(
          title: choice.label,
          titleColor: on
              ? MiuixBasicComponentColors(
                  color: c.primary,
                  disabledColor: c.primary,
                )
              : null,
          summary: choice.summary,
          insideMargin: const EdgeInsets.symmetric(
            horizontal: 24,
            vertical: 14,
          ),
          endActions: on
              ? [
                  MiuixIcon(
                    vector: MiuixIcons.os4.ok,
                    size: 22,
                    tint: c.primary,
                  ),
                ]
              : null,
          onClick: () => Navigator.pop(ctx, choice.value),
        ),
      );
    }
    return ListView(
      shrinkWrap: true,
      padding: const EdgeInsets.only(bottom: 12),
      children: rows,
    );
  },
);

/// 确认对话框，返回是否确认。
Future<bool> showNekoConfirm(
  BuildContext context, {
  required String title,
  String? message,
  String confirm = '确定',
  String cancel = '取消',
  bool danger = false,
}) async {
  final result = await showGeneralDialog<bool>(
    context: context,
    barrierDismissible: true,
    barrierLabel: cancel,
    barrierColor: context.mx.windowDimming,
    transitionDuration: const Duration(milliseconds: 200),
    transitionBuilder: (_, animation, _, child) => FadeTransition(
      opacity: CurvedAnimation(parent: animation, curve: Curves.easeOut),
      child: ScaleTransition(
        scale: Tween(begin: .94, end: 1.0).animate(
          CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
        ),
        child: child,
      ),
    ),
    pageBuilder: (ctx, _, _) {
      final c = ctx.mx;
      return SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: DecoratedBox(
                decoration: ShapeDecoration(
                  color: c.surfaceContainer,
                  shape: NekoShape.squircle(30),
                ),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(24, 26, 24, 20),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      MiuixText(
                        title,
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                        textAlign: TextAlign.center,
                      ),
                      if (message != null) ...[
                        const SizedBox(height: 10),
                        MiuixText(
                          message,
                          fontSize: 14.5,
                          height: 1.5,
                          textAlign: TextAlign.center,
                          color: c.onSurfaceVariantSummary,
                        ),
                      ],
                      const SizedBox(height: 24),
                      Row(
                        children: [
                          Expanded(
                            child: ActionButton(
                              cancel,
                              onPressed: () => Navigator.pop(ctx, false),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: ActionButton(
                              confirm,
                              isPrimary: !danger,
                              danger: danger,
                              onPressed: () => Navigator.pop(ctx, true),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    },
  );
  return result ?? false;
}

/// 可折叠条目（替代 Material ExpansionTile）。
class NekoDisclosure extends StatefulWidget {
  const NekoDisclosure({
    super.key,
    required this.title,
    this.subtitle,
    this.children = const [],
    this.childrenPadding = const EdgeInsets.fromLTRB(16, 0, 16, 12),
    this.initiallyExpanded = false,
  });

  final Widget title;
  final Widget? subtitle;
  final List<Widget> children;
  final EdgeInsetsGeometry childrenPadding;
  final bool initiallyExpanded;

  @override
  State<NekoDisclosure> createState() => _NekoDisclosureState();
}

class _NekoDisclosureState extends State<NekoDisclosure> {
  late bool expanded = widget.initiallyExpanded;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MiuixPressable(
          onPressed: () => setState(() => expanded = !expanded),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      DefaultTextStyle(
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: c.onSurface,
                        ),
                        child: widget.title,
                      ),
                      if (widget.subtitle != null)
                        DefaultTextStyle(
                          style: TextStyle(
                            fontSize: 13,
                            color: c.onSurfaceVariantSummary,
                          ),
                          child: widget.subtitle!,
                        ),
                    ],
                  ),
                ),
                AnimatedRotation(
                  turns: expanded ? .25 : 0,
                  duration: const Duration(milliseconds: 180),
                  child: MiuixIcon(
                    vector: MiuixIcons.os4.chevronForward,
                    size: 18,
                    tint: c.onSurfaceVariantActions,
                  ),
                ),
              ],
            ),
          ),
        ),
        if (expanded)
          Padding(
            padding: widget.childrenPadding,
            child: DefaultTextStyle(
              style: TextStyle(
                fontSize: 13.5,
                height: 1.5,
                color: c.onSurfaceSecondary,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: widget.children,
              ),
            ),
          ),
      ],
    );
  }
}
