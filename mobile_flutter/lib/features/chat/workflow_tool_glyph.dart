import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../../ui/theme.dart';
import 'desktop_workflow_icons.dart';
import 'tool_presentation.dart';
import 'workflow_style.dart';

class WorkflowToolGlyph extends StatelessWidget {
  const WorkflowToolGlyph({
    super.key,
    required this.presentation,
    required this.running,
    required this.failed,
  });
  final ToolPresentation presentation;
  final bool running, failed;

  @override
  Widget build(BuildContext context) {
    if (running) return const _ToolSpinner();
    var asset = 'tool';
    var brand = false;
    final icon = presentation.icon;
    if (failed) {
      asset = 'warning';
    } else if (presentation.isShell) {
      asset = presentation.prompt.endsWith(' \$') ? 'server' : 'console';
    } else if (icon == Icons.description_outlined ||
        icon == Icons.edit_note_rounded) {
      final file = presentation.subject.toLowerCase();
      String? matched = desktopFileNames[file];
      for (final entry in desktopFilePrefixes.entries) {
        if (matched == null && file.startsWith(entry.key)) {
          matched = entry.value;
        }
      }
      final dot = file.lastIndexOf('.');
      matched ??= dot > 0
          ? desktopFileExtensions[file.substring(dot + 1)]
          : null;
      asset = matched ?? 'file';
      brand = matched != null;
    } else if (icon == Icons.search_rounded ||
        icon == Icons.manage_search_rounded ||
        icon == Icons.saved_search_rounded ||
        icon == Icons.travel_explore_rounded) {
      asset = 'search';
    } else if (icon == Icons.folder_open_rounded) {
      asset = 'folder';
    } else if (icon == Icons.language_rounded || icon == Icons.public_rounded) {
      asset = 'globe';
    }
    return SvgPicture.asset(
      'assets/workflow/$asset.svg',
      width: 14,
      height: 14,
      colorFilter: brand
          ? null
          : ColorFilter.mode(
              failed ? context.mx.error : WorkflowStyle.muted(context),
              BlendMode.srcIn,
            ),
    );
  }
}

class _ToolSpinner extends StatefulWidget {
  const _ToolSpinner();
  @override
  State<_ToolSpinner> createState() => _ToolSpinnerState();
}

class _ToolSpinnerState extends State<_ToolSpinner>
    with SingleTickerProviderStateMixin {
  late final controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1300),
  );
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      controller.stop();
    } else if (!controller.isAnimating) {
      controller.repeat();
    }
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    child: SvgPicture.asset(
      'assets/workflow/spinner.svg',
      width: 14,
      height: 14,
      colorFilter: ColorFilter.mode(
        WorkflowStyle.muted(context),
        BlendMode.srcIn,
      ),
    ),
    builder: (_, child) => Transform.rotate(
      angle: (controller.value * 26).floor() / 26 * math.pi * 2,
      child: child,
    ),
  );
}
