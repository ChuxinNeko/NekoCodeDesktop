import 'package:flutter/material.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';

/// BaoCode 风格的人机交互确认面板 (Interaction / WorkflowPanel)
class WorkflowPanel extends StatelessWidget {
  const WorkflowPanel({super.key, required this.controller});
  final MobileController controller;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final workflow = object(controller.snapshot?['workflow']);
    final request = object(workflow['request']);
    final questions = records(request['questions']);

    if (request.isEmpty || questions.isEmpty) {
      return const SizedBox.shrink();
    }

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: isDark ? BaoColors.darkSurface : BaoColors.lightSurface,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(
          color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
          width: 0.8,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Icon(
                Icons.help_outline_rounded,
                size: 15,
                color: BaoColors.accent,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  string(request['title'], '需要您的确认'),
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          for (final q in questions) ...[
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Text(
                string(q['question']),
                style: TextStyle(
                  fontSize: 12.5,
                  color: isDark ? BaoColors.darkText : BaoColors.lightText,
                ),
              ),
            ),
            const SizedBox(height: 4),
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: [
                for (final opt in records(q['options']))
                  ActionButton(
                    string(opt['label']),
                    isPrimary: true,
                    onPressed: controller.busy
                        ? null
                        : () => controller.answer({
                              'requestId': request['id'],
                              'answers': {
                                q['id'] as String: {'optionId': opt['id']},
                              },
                            }),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
