import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/protocol.dart';
import 'extension_dialog.dart';

String pretty(dynamic value) =>
    value is String ? value : const JsonEncoder.withIndent('  ').convert(value);

class RunDetails extends StatelessWidget {
  const RunDetails({super.key, required this.run, this.title});
  final Json run;
  final String? title;
  @override
  Widget build(BuildContext context) => ExpansionTile(
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
        ExpansionTile(
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
    return ExpansionTile(
      title: Text('Fusion · ${state['status']}'),
      childrenPadding: const EdgeInsets.all(12),
      children: [
        Text(
          'Main · ${object(state['lanes'])['main']} · ${object(state['models'])['main']}',
        ),
        Text(
          'Sidekick · ${object(state['lanes'])['sidekick']} · ${object(state['models'])['sidekick']}',
        ),
        for (final event in events.where((e) => e['type'] == 'plan.completed'))
          ExpansionTile(
            title: Text('计划 · ${object(event['plan'])['complexity']}'),
            children: [SelectableText(pretty(event['plan']))],
          ),
        for (final worker in events.where(
          (e) => e['type'] == 'task.started' && e['role'] == 'sidekick',
        ))
          _worker(worker, events),
        if (state['error'] != null) SelectableText(string(state['error'])),
        ExpansionTile(
          title: const Text('全部事件'),
          children: [SelectableText(pretty(events))],
        ),
      ],
    );
  }

  Widget _worker(Json worker, List<Json> events) {
    final own = events
        .where((e) => e['workerId'] == worker['workerId'])
        .toList();
    final done = own
        .where((e) => ['task.completed', 'task.failed'].contains(e['type']))
        .lastOrNull;
    return ExpansionTile(
      title: Text('${worker['task']} · ${done?['type'] ?? 'running'}'),
      children: [
        SelectableText('${worker['workerId']} · ${worker['model']}'),
        ExpansionTile(
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
          ExpansionTile(
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
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: BoxConstraints(
      maxHeight: !below && ui['dialog'] != null
          ? MediaQuery.sizeOf(context).height * .45
          : 180,
    ),
    child: SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!below && ui['dialog'] != null)
            if (onAnswer != null)
              ExtensionDialogCard(
                key: ValueKey(object(ui['dialog'])['id']),
                dialog: object(ui['dialog']),
                queued: (ui['queued'] as num? ?? 0).toInt(),
                onAnswer: onAnswer!,
              )
            else
              const Padding(
                padding: EdgeInsets.all(8),
                child: Text('扩展正在等待电脑端回答，请在电脑端继续。'),
              ),
          for (final widget in records(
            ui['widgets'],
          ).where((w) => (w['placement'] == 'belowEditor') == below))
            Padding(
              padding: const EdgeInsets.all(8),
              child: SelectableText(
                (widget['lines'] as List? ?? []).join('\n'),
              ),
            ),
          if (!below && streaming && ui['working'] != null)
            Text(string(ui['working'])),
          if (!below)
            for (final status in records(ui['statuses']))
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Text(string(status['text'])),
              ),
        ],
      ),
    ),
  );
}
