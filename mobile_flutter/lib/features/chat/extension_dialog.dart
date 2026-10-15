import 'package:flutter/material.dart';

import '../../core/protocol.dart';
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
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              string(d['title']),
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
            ),
            if (widget.queued > 0)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  '另有 ${widget.queued} 项等待回答',
                  style: const TextStyle(fontSize: 12, color: Colors.grey),
                ),
              ),
            if (d['message'] != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: SelectableText(string(d['message'])),
              ),
            if (kind == 'select')
              for (final option in d['options'] as List? ?? [])
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: ActionButton(
                    '$option',
                    onPressed: busy ? null : () => send({'value': option}),
                  ),
                ),
            if (kind == 'input' || kind == 'editor')
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: TextField(
                  controller: text,
                  enabled: !busy,
                  minLines: kind == 'editor' ? 4 : 1,
                  maxLines: kind == 'editor' ? 8 : 1,
                  decoration: InputDecoration(
                    labelText: string(d['placeholder'], '输入回答'),
                  ),
                  onSubmitted: kind == 'input'
                      ? (_) => send({'value': text.text})
                      : null,
                ),
              ),
            ErrorNotice(error),
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
            if (busy) const Padding(
              padding: EdgeInsets.only(top: 10),
              child: LinearProgressIndicator(),
            ),
          ],
        ),
      ),
    );
  }
}
