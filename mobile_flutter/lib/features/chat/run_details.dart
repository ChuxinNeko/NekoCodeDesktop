import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import 'extension_dialog.dart';

String pretty(dynamic value) =>
    value is String ? value : const JsonEncoder.withIndent('  ').convert(value);

Widget _card(Widget child) => Padding(
  padding: const EdgeInsets.symmetric(vertical: 4),
  child: MiuixCard(cornerRadius: NekoShape.card - 4, child: child),
);

class RunDetails extends StatelessWidget {
  const RunDetails({super.key, required this.run, this.title});
  final Json run;
  final String? title;
  @override
  Widget build(BuildContext context) => _card(
    NekoDisclosure(
      title: Text(
        title ?? string(run['description'], string(run['query'], '运行详情')),
      ),
      subtitle: Text(
        [
          run['status'],
          run['model'],
          run['outcome'],
        ].whereType<String>().join(' · '),
      ),
      childrenPadding: const EdgeInsets.all(12),
      children: [
        for (final field in ['id', 'writablePaths', 'startedAt', 'endedAt'])
          if (run[field] != null)
            Align(
              alignment: Alignment.centerLeft,
              child: SelectableText('$field: ${pretty(run[field])}'),
            ),
        for (final step in records(run['steps']))
          NekoDisclosure(
            title: Text(string(step['toolName'], string(step['kind']))),
            subtitle: Text(string(step['status'])),
            children: [
              for (final key in [
                'text',
                'args',
                'output',
                'startedAt',
                'endedAt',
              ])
                if (step[key] != null)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: SelectableText('$key: ${pretty(step[key])}'),
                  ),
            ],
          ),
        if (run['result'] != null) SelectableText(string(run['result'])),
      ],
    ),
  );
}

class FusionInspector extends StatelessWidget {
  const FusionInspector({super.key, required this.state});
  final Json state;
  @override
  Widget build(BuildContext context) {
    final events = records(state['events']);
    if (state['status'] == 'idle' && events.isEmpty) {
      return const SizedBox.shrink();
    }
    return _card(
      NekoDisclosure(
        title: Text('Fusion · ${state['status']}'),
        childrenPadding: const EdgeInsets.all(12),
        children: [
          Text(
            'Main · ${object(state['lanes'])['main']} · ${object(state['models'])['main']}',
          ),
          Text(
            'Sidekick · ${object(state['lanes'])['sidekick']} · ${object(state['models'])['sidekick']}',
          ),
          for (final event in events.where(
            (e) => e['type'] == 'plan.completed',
          ))
            NekoDisclosure(
              title: Text('计划 · ${object(event['plan'])['complexity']}'),
              children: [SelectableText(pretty(event['plan']))],
            ),
          for (final worker in events.where(
            (e) => e['type'] == 'task.started' && e['role'] == 'sidekick',
          ))
            _worker(worker, events),
          if (state['error'] != null) SelectableText(string(state['error'])),
          NekoDisclosure(
            title: const Text('全部事件'),
            children: [SelectableText(pretty(events))],
          ),
        ],
      ),
    );
  }

  Widget _worker(Json worker, List<Json> events) {
    final own = events
        .where((e) => e['workerId'] == worker['workerId'])
        .toList();
    final done = own
        .where((e) => ['task.completed', 'task.failed'].contains(e['type']))
        .lastOrNull;
    return NekoDisclosure(
      title: Text('${worker['task']} · ${done?['type'] ?? 'running'}'),
      children: [
        SelectableText('${worker['workerId']} · ${worker['model']}'),
        NekoDisclosure(
          title: const Text('思考'),
          children: [
            SelectableText(
              own
                  .where((e) => e['type'] == 'task.reasoning.delta')
                  .map((e) => string(e['delta']))
                  .join(),
            ),
          ],
        ),
        SelectableText(
          done == null
              ? own
                    .where((e) => e['type'] == 'task.output.delta')
                    .map((e) => string(e['delta']))
                    .join()
              : string(done['text'], string(done['message'])),
        ),
        for (final tool in own.where((e) => e['type'] == 'tool.started'))
          NekoDisclosure(
            title: Text(string(tool['toolName'])),
            children: [
              SelectableText(
                pretty({
                  'input': tool['input'],
                  'result': own
                      .where(
                        (e) =>
                            e['toolCallId'] == tool['toolCallId'] &&
                            [
                              'tool.completed',
                              'tool.failed',
                            ].contains(e['type']),
                      )
                      .lastOrNull,
                }),
              ),
            ],
          ),
      ],
    );
  }
}

class ExtensionWidgets extends StatelessWidget {
  const ExtensionWidgets({
    super.key,
    required this.ui,
    required this.below,
    this.streaming = false,
    this.onAnswer,
  });
  final Future<void> Function(Json)? onAnswer;
  final Json ui;
  final bool below, streaming;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    final muted = TextStyle(
      fontSize: 13,
      height: 1.45,
      color: c.onSurfaceVariantSummary,
    );
    final lines = records(ui['widgets'])
        .where((w) => (w['placement'] == 'belowEditor') == below)
        .toList();
    final statuses = below ? <Json>[] : records(ui['statuses']);
    final working = !below && streaming && ui['working'] != null;
    final dialog = !below && ui['dialog'] != null;
    if (!dialog && lines.isEmpty && statuses.isEmpty && !working) {
      return const SizedBox.shrink();
    }
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: dialog ? MediaQuery.sizeOf(context).height * .45 : 180,
      ),
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (dialog)
              if (onAnswer != null)
                ExtensionDialogCard(
                  key: ValueKey(object(ui['dialog'])['id']),
                  dialog: object(ui['dialog']),
                  queued: (ui['queued'] as num? ?? 0).toInt(),
                  onAnswer: onAnswer!,
                )
              else
                Padding(
                  padding: const EdgeInsets.all(8),
                  child: Text('扩展正在等待电脑端回答，请在电脑端继续。', style: muted),
                ),
            for (final widget in lines)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                child: SelectableText(
                  (widget['lines'] as List? ?? []).join('\n'),
                  style: muted,
                ),
              ),
            if (working)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                child: Row(
                  children: [
                    MiuixInfiniteProgressIndicator(
                      color: c.primary,
                      size: 13,
                      strokeWidth: 1.6,
                    ),
                    const SizedBox(width: 8),
                    Text(string(ui['working']), style: muted),
                  ],
                ),
              ),
            for (final status in statuses)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                child: Text(string(status['text']), style: muted),
              ),
          ],
        ),
      ),
    );
  }
}
