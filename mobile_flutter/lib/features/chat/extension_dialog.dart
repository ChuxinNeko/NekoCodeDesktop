import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';

class ExtensionDialogCard extends StatefulWidget {
  const ExtensionDialogCard({
    super.key,
    required this.dialog,
    required this.onAnswer,
    this.queued = 0,
  });
  final Json dialog;
  final int queued;
  final Future<void> Function(Json answer) onAnswer;
  @override
  State<ExtensionDialogCard> createState() => _ExtensionDialogCardState();
}

class _ExtensionDialogCardState extends State<ExtensionDialogCard> {
  late final TextEditingController text;
  bool busy = false;
  String? error;
  @override
  void initState() {
    super.initState();
    text = TextEditingController(text: string(widget.dialog['prefill']));
  }

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  Future<void> send(Json value) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.onAnswer({'id': widget.dialog['id'], ...value});
    } catch (e) {
      if (mounted) setState(() => error = '$e');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.dialog;
    final kind = d['kind'];
    final c = context.mx;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: MiuixCard(
        cornerRadius: NekoShape.card,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              MiuixText(
                string(d['title']),
                fontSize: 17,
                fontWeight: FontWeight.w700,
              ),
              if (widget.queued > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: MiuixText(
                    '另有 ${widget.queued} 项等待回答',
                    fontSize: 12.5,
                    color: c.onSurfaceVariantSummary,
                  ),
                ),
              if (d['message'] != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  child: SelectableText(
                    string(d['message']),
                    style: TextStyle(
                      fontSize: 14.5,
                      height: 1.5,
                      color: c.onSurfaceSecondary,
                    ),
                  ),
                ),
              if (kind == 'select')
                for (final option in d['options'] as List? ?? [])
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: ActionButton(
                      '$option',
                      expand: true,
                      onPressed: busy ? null : () => send({'value': option}),
                    ),
                  ),
              if (kind == 'input' || kind == 'editor')
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: MiuixTextField(
                    controller: text,
                    enabled: !busy,
                    label: string(d['placeholder'], '输入回答'),
                    minLines: kind == 'editor' ? 4 : 1,
                    maxLines: kind == 'editor' ? 8 : 1,
                    singleLine: kind == 'input',
                    onSubmitted: kind == 'input'
                        ? (_) => send({'value': text.text})
                        : null,
                  ),
                ),
              ErrorNotice(
                error,
                margin: const EdgeInsets.symmetric(vertical: 6),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (kind == 'confirm') ...[
                    ActionButton(
                      '确认',
                      isPrimary: true,
                      onPressed: busy ? null : () => send({'confirmed': true}),
                    ),
                    ActionButton(
                      '拒绝',
                      onPressed: busy ? null : () => send({'confirmed': false}),
                    ),
                  ],
                  if (kind == 'input' || kind == 'editor')
                    ActionButton(
                      '提交',
                      isPrimary: true,
                      onPressed: busy ? null : () => send({'value': text.text}),
                    ),
                  ActionButton(
                    '取消',
                    onPressed: busy ? null : () => send({'cancelled': true}),
                  ),
                ],
              ),
              if (busy)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: MiuixLinearProgressIndicator(),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
