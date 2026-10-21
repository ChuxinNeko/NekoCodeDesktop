import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nekocode_mobile/core/protocol.dart';
import 'package:nekocode_mobile/features/chat/transcript_rows.dart';
import 'package:nekocode_mobile/features/chat/work_stages.dart';

void main() {
  final fixtures = records(
    jsonDecode(File('test/fixtures/work_stages.json').readAsStringSync()),
  );
  for (final fixture in fixtures) {
    test('Desktop workflow parity: ${fixture['name']}', () {
      final rows = [
        for (final item in records(fixture['items']))
          TranscriptRow(item['kind'], item['id'], cell: object(item['cell'])),
      ];
      expect([
        for (final stage in groupWorkStages(rows))
          {
            'id': stage.id,
            'title': workStageLabel(stage),
            'completed': workStageCompleted(stage),
            'items': [
              for (final item in stage.items)
                {
                  'kind': item.kind,
                  'id': item.id,
                  'text': item.kind == 'thinking'
                      ? item.cell!['thinking']
                      : item.kind == 'tool'
                      ? ''
                      : item.cell!['text'],
                },
            ],
          },
      ], fixture['expected']);
    });
  }
  test('stage keys survive assistant persistence', () {
    List<WorkStage> stages(String id) => groupWorkStages([
      TranscriptRow(
        'thinking',
        id,
        cell: {'id': id, 'thinking': '## 检查消息结构\n细节'},
      ),
      TranscriptRow(
        'tool',
        'tool',
        cell: {
          'toolName': 'read',
          'args': {'path': 'chat.dart'},
        },
      ),
    ]);
    expect(stages('overlay').first.id, stages('persisted').first.id);
  });
  test('Flutter commands identify verification and build phases', () {
    final stages = groupWorkStages([
      for (final command in ['flutter test', 'flutter build apk'])
        TranscriptRow(
          'tool',
          command,
          cell: {
            'toolName': 'bash',
            'args': {'command': command},
          },
        ),
    ]);
    expect(stages.map(workStageLabel), ['检查类型与测试结果', '编译界面并检查构建结果']);
  });
}
