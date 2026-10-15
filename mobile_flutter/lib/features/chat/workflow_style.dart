import 'dart:async';

import 'package:flutter/material.dart';

import '../../ui/theme.dart';

/// Desktop transcript tokens (CSS logical pixels map to Flutter logical pixels).
/// Kept local so tool result cards retain the mobile theme and sizing.
abstract final class WorkflowStyle {
  static Color muted(BuildContext context) =>
      foreground(context).withValues(alpha: .65);
  static Color foreground(BuildContext context) =>
      context.isDark ? const Color(0xfffcfcfc) : const Color(0xff0d0d0d);
  static Color rule(BuildContext context) =>
      foreground(context).withValues(alpha: context.isDark ? .06 : .054);
  static TextStyle text(BuildContext context, [double size = 12]) => TextStyle(
    fontSize: size,
    height: 1.5,
    color: muted(context),
    fontWeight: FontWeight.w400,
  );
  static Widget rail(BuildContext context, Widget child) => Container(
    decoration: BoxDecoration(
      border: Border(left: BorderSide(color: rule(context))),
    ),
    padding: const EdgeInsets.only(left: 12),
    child: child,
  );
}

class WorkflowChevron extends StatelessWidget {
  const WorkflowChevron({super.key, required this.open, this.size = 14});
  final bool open;
  final double size;
  @override
  Widget build(BuildContext context) => AnimatedRotation(
    turns: open ? .25 : 0,
    duration: MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : const Duration(milliseconds: 180),
    child: CustomPaint(
      size: Size.square(size),
      painter: _ChevronPainter(WorkflowStyle.muted(context)),
    ),
  );
}

class _ChevronPainter extends CustomPainter {
  _ChevronPainter(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    // Desktop Tabler ChevronRight, viewBox 0 0 24 24, strokeWidth 2.
    canvas.drawPath(
      Path()
        ..moveTo(size.width * 9 / 24, size.height / 4)
        ..lineTo(size.width * 15 / 24, size.height / 2)
        ..lineTo(size.width * 9 / 24, size.height * 3 / 4),
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = size.width / 12
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(_ChevronPainter oldDelegate) => oldDelegate.color != color;
}

/// Same two-second neutral sweep as desktop's shimmer utility.
class WorkflowShimmer extends StatefulWidget {
  const WorkflowShimmer({super.key, required this.child, this.active = true});
  final Widget child;
  final bool active;
  @override
  State<WorkflowShimmer> createState() => _WorkflowShimmerState();
}

class _WorkflowShimmerState extends State<WorkflowShimmer>
    with SingleTickerProviderStateMixin {
  late final AnimationController animation = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 2),
  );
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    sync();
  }

  @override
  void didUpdateWidget(covariant WorkflowShimmer oldWidget) {
    super.didUpdateWidget(oldWidget);
    sync();
  }

  void sync() {
    if (widget.active && !MediaQuery.disableAnimationsOf(context)) {
      if (!animation.isAnimating) animation.repeat();
    } else {
      animation.stop();
    }
  }

  @override
  void dispose() {
    animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active || MediaQuery.disableAnimationsOf(context)) {
      return widget.child;
    }
    final original = widget.child;
    final mask = original is Text && original.data != null
        ? Text(
            original.data!,
            style: original.style?.copyWith(color: Colors.white),
            maxLines: original.maxLines,
            overflow: original.overflow,
            textAlign: original.textAlign,
            softWrap: original.softWrap,
            textScaler: original.textScaler,
            semanticsLabel: original.semanticsLabel,
          )
        : original;
    return AnimatedBuilder(
      animation: animation,
      child: mask,
      builder: (context, child) => ShaderMask(
        blendMode: BlendMode.srcIn,
        shaderCallback: (bounds) {
          final x = (animation.value * 40).floor() / 40 * 4 - 2;
          return LinearGradient(
            begin: Alignment(x - .6, 0),
            end: Alignment(x + .6, 0),
            colors: [
              WorkflowStyle.muted(context),
              context.isDark
                  ? Colors.white
                  : WorkflowStyle.muted(context).withValues(alpha: .13),
              WorkflowStyle.muted(context),
            ],
          ).createShader(bounds);
        },
        child: child,
      ),
    );
  }
}

class WorkflowElapsed extends StatefulWidget {
  const WorkflowElapsed({
    super.key,
    required this.active,
    required this.startedAt,
    required this.endedAt,
    required this.working,
    this.hasEnd = true,
  });
  final bool active, working, hasEnd;
  final int startedAt, endedAt;
  @override
  State<WorkflowElapsed> createState() => _WorkflowElapsedState();
}

class WorkflowToolDuration extends StatefulWidget {
  const WorkflowToolDuration({
    super.key,
    required this.running,
    required this.startedAt,
    required this.endedAt,
  });
  final bool running;
  final int startedAt, endedAt;
  @override
  State<WorkflowToolDuration> createState() => _WorkflowToolDurationState();
}

class _WorkflowToolDurationState extends State<WorkflowToolDuration> {
  Timer? timer;
  @override
  void initState() {
    super.initState();
    sync();
  }

  @override
  void didUpdateWidget(covariant WorkflowToolDuration oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.running != oldWidget.running) sync();
  }

  void sync() {
    timer?.cancel();
    if (widget.running) {
      timer = Timer.periodic(const Duration(milliseconds: 100), (_) {
        if (mounted) setState(() {});
      });
    }
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ms =
        ((widget.running
                    ? DateTime.now().millisecondsSinceEpoch
                    : widget.endedAt) -
                widget.startedAt)
            .clamp(0, 1 << 53);
    final label = ms < 10000
        ? '${(ms / 1000).toStringAsFixed(1)}s'
        : ms < 60000
        ? '${(ms / 1000).round()}s'
        : '${ms ~/ 60000}m ${((ms % 60000) / 1000).round()}s';
    return Text(label, style: WorkflowStyle.text(context, 11));
  }
}

class _WorkflowElapsedState extends State<WorkflowElapsed> {
  Timer? timer;
  @override
  void initState() {
    super.initState();
    sync();
  }

  @override
  void didUpdateWidget(covariant WorkflowElapsed oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active != widget.active) sync();
  }

  void sync() {
    timer?.cancel();
    if (widget.active) {
      timer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    }
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final end = widget.active
        ? DateTime.now().millisecondsSinceEpoch
        : widget.endedAt;
    final seconds = ((end - widget.startedAt) ~/ 1000).clamp(0, 1 << 31);
    final time = seconds < 60
        ? '${seconds}s'
        : '${seconds ~/ 60}m ${seconds % 60}s';
    final label = widget.working
        ? '${widget.active ? 'Working' : 'Worked'} for $time'
        : widget.active
        ? 'Thinking for $time'
        : widget.hasEnd
        ? 'Thought for $time'
        : 'Thought';
    return WorkflowShimmer(
      active: widget.active && !widget.working,
      child: Text(
        label,
        style: WorkflowStyle.text(context, widget.working ? 13 : 12).copyWith(
          fontWeight: widget.working ? FontWeight.w500 : FontWeight.w400,
        ),
      ),
    );
  }
}
