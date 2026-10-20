import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import 'theme.dart';

/// 传给页面内容的布局上下文。
class GlassScope {
  const GlassScope(this.padding, this.controller, this.behavior);

  /// 顶栏 / 底栏占用的内边距，应用到滚动体 padding。
  final EdgeInsets padding;
  final ScrollController controller;

  /// 折叠大标题时的滚动行为（未启用大标题时为 null）。
  final MiuixScrollBehavior? behavior;
}

typedef GlassBody = Widget Function(BuildContext context, GlassScope scope);

/// HyperOS 4 页面骨架：玻璃顶栏（可折叠大标题）+ 内容 + 可选悬浮玻璃底栏。
///
/// [body] 必须返回一个使用 [GlassScope.controller] 的滚动体，并把
/// [GlassScope.padding] 应用到其内边距上（顶栏、底栏高度已包含在内）。
class GlassPage extends StatefulWidget {
  const GlassPage({
    super.key,
    required this.title,
    this.largeTitle,
    this.subtitle = '',
    this.navigationIcon,
    this.actions = const [],
    this.bottomBar,
    this.bottomContent,
    required this.body,
    this.floatingActionButton,
    this.scrollController,
    this.pinnedSmallTitle = false,
    this.floatingActions = false,
  });

  /// 顶栏按钮始终以 HyperOS 4 玻璃圆钮悬浮显示（首页 / 聊天页），
  /// 不必等内容滚动后才浮起。
  final bool floatingActions;

  final String title, subtitle;

  /// 固定显示小标题（聊天等不需要大标题的页面）。
  final bool pinnedSmallTitle;

  /// 外部持有的滚动控制器（聊天页需要自行 jumpTo）；为空时内部创建。
  final ScrollController? scrollController;

  /// 非空时启用「展开大标题 → 滚动折叠为小标题」。
  final String? largeTitle;
  final Widget? navigationIcon, bottomContent, floatingActionButton;
  final List<Widget> actions;
  final Widget Function(BuildContext context, MiuixLayerBackdrop backdrop)?
  bottomBar;
  final GlassBody body;

  @override
  State<GlassPage> createState() => _GlassPageState();
}

class _GlassPageState extends State<GlassPage> {
  final backdrop = MiuixLayerBackdrop();
  late final ScrollController scroll;
  MiuixExitUntilCollapsedScrollBehavior? behavior;
  bool scrolled = false;

  @override
  void initState() {
    super.initState();
    scroll = widget.scrollController ?? ScrollController();
    if (widget.largeTitle != null || widget.pinnedSmallTitle) {
      behavior = MiuixExitUntilCollapsedScrollBehavior(
        // 固定小标题：从首帧起就是折叠态，避免大标题闪现。
        state: widget.pinnedSmallTitle
            ? MiuixTopAppBarState(
                initialHeightOffsetLimit: -100,
                initialHeightOffset: -100,
              )
            : null,
      );
    }
    if (widget.pinnedSmallTitle) {
      final state = behavior!.state;
      void keepCollapsed() {
        final limit = state.heightOffsetLimit;
        if (limit.isFinite && state.heightOffset != limit) {
          state.heightOffset = limit;
        }
      }

      state.addListener(keepCollapsed);
    }
    scroll.addListener(_onScroll);
  }

  void _onScroll() {
    final value = scroll.hasClients && scroll.offset > 0;
    if (value != scrolled) setState(() => scrolled = value);
  }

  @override
  void dispose() {
    scroll.removeListener(_onScroll);
    if (widget.scrollController == null) scroll.dispose();
    behavior?.state.dispose();
    backdrop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final surface = context.mx.surface;
    Widget content(EdgeInsets padding) {
      final body = widget.body(context, GlassScope(padding, scroll, behavior));
      return MiuixLayerBackdropCapture(
        backdrop: backdrop,
        child: ColoredBox(
          color: surface,
          child: behavior == null || widget.pinnedSmallTitle
              ? body
              : MiuixScrollBehaviorListener(behavior: behavior!, child: body),
        ),
      );
    }

    return Material(
      color: surface,
      child: MiuixScaffold(
        containerColor: surface,
        topBar: MiuixGlassTopAppBar(
          title: widget.title,
          largeTitle: widget.largeTitle,
          subtitle: widget.subtitle,
          backdrop: backdrop,
          scrollBehavior: behavior,
          isContentScrolled: widget.floatingActions || scrolled,
          navigationIcon: widget.navigationIcon,
          actions: widget.actions,
          bottomContent: widget.bottomContent,
        ),
        bottomBar: widget.bottomBar == null
            ? null
            : SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(40, 8, 40, 12),
                  child: widget.bottomBar!(context, backdrop),
                ),
              ),
        floatingActionButton: widget.floatingActionButton,
        content: content,
      ),
    );
  }
}

/// 顶栏上的玻璃图标按钮（统一 OS4 符号图标）。
class GlassAction extends StatelessWidget {
  const GlassAction({
    super.key,
    required this.icon,
    required this.onPressed,
    this.tooltip,
    this.size = 24,
  });
  final MiuixVectorIcon icon;
  final VoidCallback? onPressed;
  final String? tooltip;
  final double size;
  @override
  Widget build(BuildContext context) => MiuixGlassIconButton(
    onPressed: onPressed ?? () {},
    tooltip: tooltip,
    semanticLabel: tooltip,
    child: MiuixIcon(vector: icon, size: size),
  );
}
