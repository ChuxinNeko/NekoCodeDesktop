import 'package:flutter_test/flutter_test.dart';
import 'package:nekocode_mobile/core/protocol.dart';
import 'package:nekocode_mobile/features/chat/file_changes.dart';
import 'package:nekocode_mobile/features/chat/transcript_rows.dart';

Json prompt(String id) => {'id': id, 'type': 'user', 'text': id};
Json edit(String path, {String status = 'done', Json? args, Json? details}) => {
  'id': path,
  'type': 'tool',
  'toolName': 'edit',
  'status': status,
  'args': {
    'path': path,
    'oldText': 'old\n',
    'newText': 'new\nextra\n',
    ...?args,
  },
  'details': ?details,
};
Json checkpoint(String id, String promptId, List<Json> files) => {
  'id': id,
  'cellId': promptId,
  'files': files,
};
Json file(String path, int added, int removed) => {
  'path': path,
  'additions': added,
  'deletions': removed,
};

void main() {
  test('line counts respect trailing CRLF and partial inputs', () {
    final cell = {
      'toolName': 'write',
      'status': 'running',
      'args': {'path': 'a.dart', 'content': 'one\r\ntwo\r\npartial'},
      'inputStreaming': true,
    };
    expect(fileEditStats(cell, active: true).additions, 2);
    cell['args'] = {'content': ''};
    expect(fileEditStats(cell).additions, 0);
    expect(fileEditStats(edit('a')).additions, 2);
    expect(fileEditStats(edit('a')).deletions, 1);
  });
  test('remote count hints are exact even when source inputs were clipped', () {
    final cell = {
      ...edit('a', status: 'running'),
      'changeStats': {'insertions': 10003, 'deletions': 9},
    };
    expect(fileEditStats(cell, active: true).additions, 10000);
    expect(fileEditStats(cell, active: true).deletions, 5);
    expect(
      fileEditStats({...cell, 'status': 'done'}, active: true).additions,
      10003,
    );
    expect(fileEditStats({...cell, 'status': 'error'}).additions, 0);
  });
  test('numbered and unified result diffs skip file headers and context', () {
    for (final diff in [
      '-1 old\n+1 new\n+2 more\n 3 context',
      '--- a\n+++ b\n@@ -1 +1,2 @@\n-old\n+new\n+more',
    ]) {
      final stats = fileEditStats(edit('a', details: {'diff': diff}));
      expect(stats.additions, 2);
      expect(stats.deletions, 1);
    }
  });
  test(
    'multi-edit inputs, failed edits and legacy omission notices are safe',
    () {
      final stats = fileEditStats({
        'toolName': 'edit',
        'args': {
          'edits': [
            {'oldText': 'a\n', 'newText': 'b\nc\n'},
            null,
            {'oldText': 'd', 'newText': 'e'},
          ],
        },
      });
      expect(stats.additions, 3);
      expect(stats.deletions, 2);
      expect(fileEditStats(edit('a', status: 'error')).additions, 0);
      expect(
        fileEditStats({
          'toolName': 'write',
          'args': {'content': 'one\ntwo\n…（另有 10 KB 未传输，请在电脑端查看完整内容）'},
        }).additions,
        1,
      );
    },
  );
  test(
    'live changes replace matching checkpoint files and retain worker edits',
    () {
      final checkpoints = [
        checkpoint('cp', 'u', [
          file('src/a.dart', 99, 99),
          file('worker.dart', 7, 3),
        ]),
      ];
      final changes = activeTurnChanges(
        [
          prompt('u'),
          edit(r'C:\project\src\a.dart'),
          edit('./src/a.dart'),
          edit('bad', status: 'error'),
        ],
        checkpoints,
        live: true,
        cwd: r'C:\project',
      )!;
      expect(changes.files.map((f) => f.path), ['src/a.dart', 'worker.dart']);
      expect(changes.additions, 11);
      expect(changes.deletions, 5);
      final settled = activeTurnChanges(
        [prompt('u'), edit('src/a.dart')],
        checkpoints,
        live: false,
      )!;
      expect(settled.additions, 106);
    },
  );
  test(
    'new prompts and missing checkpoints never show previous turn changes',
    () {
      final saved = [
        checkpoint('cp', 'old', [file('old.dart', 2, 1)]),
      ];
      expect(
        activeTurnChanges([prompt('old'), prompt('new')], saved, live: true),
        isNull,
      );
      expect(activeTurnChanges([edit('a')], saved, live: true), isNull);
      expect(
        activeTurnChanges(
          [prompt('old')],
          [checkpoint('empty', 'old', [])],
          live: true,
        ),
        isNull,
      );
    },
  );
  test(
    'completed capsules stay on their final row, including stopped runs',
    () {
      final rows = [
        TranscriptRow('user', 'u1', cell: prompt('u1')),
        TranscriptRow('message', 'r1', cell: {'text': 'reply'}),
        TranscriptRow('user', 'u2', cell: prompt('u2')),
        TranscriptRow('work', 'w2'),
      ];
      final saved = [
        checkpoint('newer', 'u1', [file('a', 2, 0)]),
        checkpoint('older', 'u1', [file('wrong', 3, 0)]),
        checkpoint('cp2', 'u2', [file('b', 4, 1)]),
      ];
      final live = completedTurnChanges(rows, saved, streaming: true);
      expect(live.keys, ['r1']);
      expect(live['r1']!.checkpointId, 'newer');
      expect(completedTurnChanges(rows, saved, streaming: false).keys, [
        'r1',
        'w2',
      ]);
    },
  );
  test(
    'complete-turn hint survives a clipped remote history and remains turn-scoped',
    () {
      final hint = checkpoint('cp', 'u', [file('a.dart', 100, 7)]);
      final snapshot = <String, dynamic>{
        'streaming': true,
        'cells': [edit('a.dart')],
        'checkpoints': [],
        'currentTurnChanges': hint,
      };
      final changes = snapshotTurnChanges(snapshot)!;
      expect(changes.additions, 100);
      expect(
        completedTurnChanges(
          [TranscriptRow('message', 'reply')],
          [],
          streaming: false,
          currentHint: changes,
        ).keys,
        ['reply'],
      );
      snapshot['cells'] = [prompt('new')];
      expect(snapshotTurnChanges(snapshot), isNull);
    },
  );
}

// The desktop's complete-turn hint is authoritative when the remote tail has
// lost the prompt and first edits. It must still disappear for a newer prompt.
