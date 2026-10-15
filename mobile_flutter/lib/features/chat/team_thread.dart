import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import 'transcript.dart';

/// Projects the same server event stream as shared/team-thread.ts.
List<Json> projectTeamItems(List<Json> events) {
  final items = <Json>[];
  final workers = <String, Json>{};
  String admin = '';
  Json? adminMessage;
  String member(dynamic task) =>
      RegExp(r'^@([^\s:]+)').firstMatch(string(task))?.group(1) ?? string(task);
  Json bubble() {
    if (adminMessage != null) return adminMessage!;
    final result = <String, dynamic>{
      'kind': 'message',
      'member': admin,
      'text': '',
      'tools': <Json>[],
      'status': 'running',
    };
    items.add(result);
    adminMessage = result;
    return result;
  }

  Json? owner(Json event) => event['workerId'] != null
      ? workers[event['workerId']]
      : event['role'] == 'main'
      ? bubble()
      : null;
  for (final e in events) {
    switch (e['type']) {
      case 'task.started':
        if (e['role'] == 'main') {
          admin = member(e['task']);
        } else if (e['workerId'] is String) {
          final item = <String, dynamic>{
            'kind': 'message',
            'member': member(e['task']),
            'model': e['model'],
            'text': '',
            'tools': <Json>[],
            'status': 'running',
          };
          workers[e['workerId'] as String] = item;
          items.add(item);
        }
      case 'session.output.delta':
        final b = bubble();
        b['text'] = string(b['text']) + string(e['delta']);
      case 'task.output.delta':
        final b = workers[e['workerId']];
        if (b != null) b['text'] = string(b['text']) + string(e['delta']);
      case 'task.completed':
        if (e['role'] == 'main') {
          for (final item in items.where(
            (i) => i['kind'] == 'message' && i['member'] == admin,
          )) {
            item['status'] = 'done';
          }
        } else {
          final b = workers[e['workerId']];
          if (b != null) {
            b['text'] = string(e['text']).isEmpty ? b['text'] : e['text'];
            b['status'] = 'done';
          }
        }
      case 'task.failed':
        final b = owner(e);
        if (b != null) {
          b['status'] = 'failed';
          b['error'] = e['message'];
        }
      case 'tool.started':
        if (e['toolName'] == 'team_assign') {
          final from = e['workerId'] != null
              ? (workers[e['workerId']]?['member'])
              : admin;
          if (e['workerId'] == null) adminMessage = null;
          for (final assignment in records(object(e['input'])['assignments'])) {
            items.add({
              'kind': 'assign',
              'member': from,
              'to': assignment['member'],
              'task': assignment['task'],
            });
          }
        } else {
          final b = owner(e);
          if (b != null) {
            (b['tools'] as List).add({
              'id': e['toolCallId'],
              'name': e['toolName'],
              'detail': e['input'],
              'status': 'running',
            });
          }
        }
      case 'tool.completed':
      case 'tool.failed':
        final b = owner(e);
        if (b != null) {
          for (final t in b['tools'] as List) {
            if (t['id'] == e['toolCallId']) {
              t['status'] = e['type'] == 'tool.completed' ? 'done' : 'failed';
            }
          }
        }
      case 'session.failed':
        for (final item in items.where(
          (i) => i['kind'] == 'message' && i['status'] == 'running',
        )) {
          item['status'] = 'failed';
          item['error'] = e['message'];
        }
    }
  }
  return items;
}

List<Json> teamTurns(Json workflow) {
  final saved = records(workflow['teamThreads']);
  final fusion = object(workflow['fusion']);
  final events = records(fusion['events']);
  if (events.any(
        (e) =>
            e['type'] == 'session.started' &&
            object(e['models'])['sidekick'] == 'team',
      ) &&
      string(fusion['prompt']).isNotEmpty &&
      !saved.any(
        (turn) =>
            turn['prompt'] == fusion['prompt'] &&
            turn['status'] == fusion['status'],
      ) &&
      ['running', 'complete', 'failed'].contains(fusion['status'])) {
    return [
      ...saved,
      {
        'prompt': fusion['prompt'],
        'status': fusion['status'],
        'items': projectTeamItems(events),
        if (fusion['status'] == 'complete' && fusion['output'] != null)
          'final': {'member': '团队', 'text': fusion['output']},
      },
    ];
  }
  return saved;
}

class TeamThreads extends StatelessWidget {
  const TeamThreads({super.key, required this.turns});
  final List<Json> turns;

  @override
  Widget build(BuildContext context) {
    final c = context.mx;
    return Column(
      children: [
        for (final turn in turns)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: MiuixCard(
              cornerRadius: NekoShape.card - 4,
              child: NekoDisclosure(
                initiallyExpanded: turn['status'] == 'running',
                title: Text('团队 · ${turn['status']}'),
                subtitle: Text(
                  string(turn['prompt']),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                children: [
                  for (final item in records(turn['items']))
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: DecoratedBox(
                        decoration: ShapeDecoration(
                          color: c.surface,
                          shape: NekoShape.squircle(16),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              MiuixText(
                                '${item['member'] ?? ''}${item['model'] == null ? '' : ' · ${item['model']}'}',
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                                color: c.primary,
                              ),
                              const SizedBox(height: 6),
                              if (item['kind'] == 'assign')
                                SelectableText(
                                  '→ @${string(item['to']).replaceFirst(RegExp(r'^@'), '')}: ${item['task']}',
                                )
                              else ...[
                                MarkdownBody(
                                  data: string(item['text']),
                                  selectable: true,
                                  styleSheet: nekoMarkdown(context, size: 14),
                                ),
                                for (final tool in records(item['tools']))
                                  Padding(
                                    padding: const EdgeInsets.only(top: 6),
                                    child: MiuixText(
                                      '${tool['name']} · ${tool['status']}${tool['detail'] == null ? '' : ' · ${tool['detail']}'}',
                                      fontSize: 12.5,
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      color: c.onSurfaceVariantSummary,
                                    ),
                                  ),
                                if (item['error'] != null)
                                  SelectableText(
                                    string(item['error']),
                                    style: TextStyle(color: c.error),
                                  ),
                                if (item['status'] == 'running')
                                  MiuixText(
                                    '正在执行…',
                                    fontSize: 12.5,
                                    color: c.primary,
                                  ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    ),
                  if (object(turn['final'])['member'] != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          MiuixText(
                            '最终回复 · ${object(turn['final'])['member']}',
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                          const SizedBox(height: 6),
                          MarkdownBody(
                            data: string(object(turn['final'])['text']),
                            selectable: true,
                            styleSheet: nekoMarkdown(context, size: 14.5),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
