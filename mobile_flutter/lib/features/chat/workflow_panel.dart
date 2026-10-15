import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';

/// 需要用户确认 / 选择时，悬浮在输入框上方的交互卡片。
class WorkflowPanel extends StatelessWidget {
  const WorkflowPanel({super.key, required this.controller});
  final MobileController controller;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    final workflow = object(controller.snapshot?['workflow']);
    final request = object(workflow['request']);
    final questions = records(request['questions']);
    if (request.isEmpty || questions.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * .42,
        ),
        child: DecoratedBox(
          decoration: ShapeDecoration(
            color: c.surfaceContainer,
            shape: NekoShape.squircle(NekoShape.card),
            shadows: const [
              BoxShadow(
                color: Color(0x14000000),
                blurRadius: 24,
                offset: Offset(0, 8),
              ),
            ],
          ),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    IconTile(
                      icon: MiuixIcons.os4.help,
                      color: c.primary,
                      size: 28,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: MiuixText(
                        string(request['title'], '需要您的确认'),
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
                for (final q in questions) ...[
                  Padding(
                    padding: const EdgeInsets.only(top: 12, bottom: 10),
                    child: MiuixText(
                      string(q['question']),
                      fontSize: 14.5,
                      height: 1.45,
                      color: c.onSurfaceSecondary,
                    ),
                  ),
                  for (final opt in records(q['options']))
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: ActionButton(
                        string(opt['label']),
                        isPrimary: true,
                        expand: true,
                        onPressed: controller.busy
                            ? null
                            : () => controller.answer({
                                'requestId': request['id'],
                                'answers': {
                                  q['id'] as String: {'optionId': opt['id']},
                                },
                              }),
                      ),
                    ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
