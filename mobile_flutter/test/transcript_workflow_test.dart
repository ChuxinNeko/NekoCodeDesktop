import 'dart:io';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nekocode_mobile/core/desktop_client.dart';
import 'package:nekocode_mobile/core/protocol.dart';
import 'package:nekocode_mobile/features/mobile_controller.dart';
import 'package:nekocode_mobile/features/chat/transcript.dart';
import 'package:nekocode_mobile/features/chat/transcript_rows.dart';
import 'package:nekocode_mobile/features/chat/work_stages.dart';
import 'package:nekocode_mobile/ui/widgets.dart';

import 'support.dart';

Json user(String id) => {
  'id': id,
  'type': 'user',
  'text': 'Fix it',
  'timestamp': 1000,
};
Json tool(String id, {String status = 'done'}) => {
  'id': id,
  'type': 'tool',
  'toolName': 'read',
  'status': status,
  'args': {'path': '/src/main.dart'},
  'output': 'Original mobile output',
  'timestamp': 3000,
  'startedAt': 2000,
};
Json message(String id, String text) => {
  'id': id,
  'type': 'assistant',
  'text': text,
  'timestamp': 4000,
};

void main() {
  testWidgets('tool output pages use the authenticated desktop endpoint', (
    tester,
  ) async {
    final calls = <Json>[];
    final desktop =
        DesktopClient(
            MemoryStore(),
            httpClient: MockClient((request) async {
              expect(request.method, 'POST');
              expect(request.url.path, '/api/tasks/task-1/tool-output');
              final body = object(jsonDecode(request.body));
              calls.add(body);
              return http.Response(
                jsonEncode({'text': 'tail', 'offset': 4, 'total': 8}),
                200,
              );
            }),
          )
          ..mode = 'lan'
          ..lan = {'endpoint': 'http://127.0.0.1:47832', 'token': 'test'};
    final c = MobileController(desktop)..taskId = 'task-1';
    addTearDown(c.dispose);
    await tester.pumpWidget(
      themed(
        Scaffold(
          body: ToolCell(
            cell: {
              ...tool('t'),
              'toolCallId': 'call-1',
              'output': 'head',
              'outputTotal': 8,
            },
            controller: c,
          ),
        ),
      ),
    );
    await tester.tap(find.text('读取文件'));
    await tester.pump();
    await tester.tap(find.text('加载更多输出'));
    await tester.pumpAndSettle();
    expect(calls.single, {'toolCallId': 'call-1', 'offset': 4});
    expect(find.text('headtail'), findsWidgets);
    expect(find.text('加载更多输出'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  if (const bool.fromEnvironment('WORKFLOW_PREVIEW')) {
    for (final brightness in Brightness.values) {
      testWidgets('preview ${brightness.name}', (tester) async {
        await tester.runAsync(() async {
          final loader = FontLoader('WorkflowPreview');
          loader.addFont(
            Future.value(
              ByteData.sublistView(
                File('C:/Windows/Fonts/segoeui.ttf').readAsBytesSync(),
              ),
            ),
          );
          loader.addFont(
            Future.value(
              ByteData.sublistView(
                File('C:/Windows/Fonts/msyh.ttc').readAsBytesSync(),
              ),
            ),
          );
          await loader.load();
          final cjk = FontLoader('WorkflowCJK')
            ..addFont(
              Future.value(
                ByteData.sublistView(
                  File('C:/Windows/Fonts/msyh.ttc').readAsBytesSync(),
                ),
              ),
            );
          await cjk.load();
          final mono = FontLoader('monospace')
            ..addFont(
              Future.value(
                ByteData.sublistView(
                  File('C:/Windows/Fonts/consola.ttf').readAsBytesSync(),
                ),
              ),
            );
          await mono.load();
        });
        tester.view.physicalSize = const Size(390, 520);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final c = MobileController(DesktopClient(MemoryStore()));
        addTearDown(c.dispose);
        final stamp = DateTime.now().millisecondsSinceEpoch;
        final row = transcriptRows([
          {
            ...message('a', ''),
            'thinking': 'Inspect the workflow layout and state transitions.',
            'timestamp': stamp - 8000,
            'thinkingEndedAt': stamp - 7000,
          },
          {...tool('t'), 'timestamp': stamp - 4000},
          {
            ...tool('s'),
            'toolName': 'bash',
            'args': {'command': 'flutter test'},
            'timestamp': stamp - 1000,
            'startedAt': stamp - 2000,
          },
        ], streaming: true).single..startedAt = stamp - 8000;
        final boundary = GlobalKey();
        await tester.pumpWidget(
          themed(
            RepaintBoundary(
              key: boundary,
              child: Scaffold(
                body: DefaultTextStyle(
                  style: const TextStyle(
                    fontFamily: 'WorkflowPreview',
                    fontFamilyFallback: ['WorkflowCJK'],
                  ),
                  child: Column(
                    children: [
                      WorkingBlock(
                        row: row,
                        controller: c,
                        active: true,
                        waiting: true,
                      ),
                      WorkingBlock(
                        row: row,
                        controller: c,
                        active: false,
                        waiting: false,
                      ),
                    ],
                  ),
                ),
              ),
            ),
            brightness: brightness,
          ),
        );
        await tester.pump(const Duration(milliseconds: 200));
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage();
          final data = await image.toByteData(format: ui.ImageByteFormat.png);
          final file = File(
            '../output/workflow-preview/${brightness.name}.png',
          );
          file.parent.createSync(recursive: true);
          file.writeAsBytesSync(data!.buffer.asUint8List());
          image.dispose();
        });
        await tester.pumpWidget(const SizedBox.shrink());
        expect(tester.takeException(), isNull);
      });
    }
  }
  test(
    'settled turns fold remarks, thinking and tools above the final reply',
    () {
      final cells = [
        user('u'),
        {...message('a', 'I will inspect'), 'thinking': 'Reason'},
        tool('t'),
        message('b', 'Another check'),
        tool('t2'),
        message('c', 'Fixed'),
      ];
      final rows = transcriptRows(cells, streaming: false);
      expect(rows.map((r) => r.kind), ['user', 'work', 'message']);
      expect(rows[1].id, 'turn-u');
      expect(rows[1].items.map((r) => r.kind), [
        'thinking',
        'message',
        'tool',
        'message',
        'tool',
      ]);
      expect(rows.last.cell!['text'], 'Fixed');
      expect(rows[1].startedAt, 2000);
      expect(rows[1].endedAt, 4000);
    },
  );

  test('live keys survive assistant persistence; history stays settled', () {
    List<TranscriptRow> live(String id) => transcriptRows([
      user('u'),
      {...message(id, ''), 'thinking': 'Inspecting'},
      tool('t', status: 'running'),
    ], streaming: true);
    expect(live('overlay').last.id, live('persisted').last.id);
    final rows = transcriptRows([
      user('u'),
      tool('t'),
      message('r', 'Done'),
      user('next'),
      tool('new', status: 'running'),
    ], streaming: true);
    expect(rows[1].id, 'turn-u');
    expect(rows.last.id, 'work-next-0');
  });

  test(
    'reasoning without tools stays a single disclosure; abort loses no steps',
    () {
      final rows = transcriptRows([
        user('u'),
        {...message('a', 'Answer'), 'thinking': 'Reason'},
      ], streaming: false);
      expect(rows.map((r) => r.kind), ['user', 'thinking', 'message']);
      expect(
        transcriptRows([user('u'), tool('t')], streaming: false).last.kind,
        'work',
      );
    },
  );

  test('Planning Next Step only waits on the model, never a running tool', () {
    expect(waitingOnModel([], true), isTrue);
    expect(waitingOnModel([user('u')], true), isTrue);
    expect(waitingOnModel([tool('t')], true), isTrue);
    expect(waitingOnModel([tool('t', status: 'error')], true), isTrue);
    expect(waitingOnModel([tool('t', status: 'running')], true), isFalse);
    expect(waitingOnModel([tool('t')], false), isFalse);
    expect(
      waitingOnModel([
        {...message('a', ''), 'streaming': true},
      ], true),
      isTrue,
    );
    expect(
      waitingOnModel([
        {
          ...message('a', ''),
          'streaming': true,
          'thinking': 'Visible reasoning',
        },
      ], true),
      isFalse,
    );
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'run folds automatically, can reopen, retains mobile details (${brightness.name})',
      (tester) async {
        tester.view.physicalSize = const Size(320, 750);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final c = MobileController(DesktopClient(MemoryStore()));
        addTearDown(c.dispose);
        final row = transcriptRows([tool('t')], streaming: true).single;
        Future<void> show(bool active) async {
          await tester.pumpWidget(
            themed(
              Scaffold(
                body: WorkingBlock(
                  key: const ValueKey('run'),
                  row: row,
                  controller: c,
                  active: active,
                  waiting: active,
                ),
              ),
              brightness: brightness,
            ),
          );
          await tester.pump(const Duration(milliseconds: 200));
        }

        await show(true);
        final title = workStageLabel(groupWorkStages(row.items).single);
        expect(find.text('Planning Next Step'), findsNothing);
        expect(find.byType(WorkStageRow), findsOneWidget);
        expect(find.byType(ToolCell), findsNothing);
        await tester.tap(find.text(title));
        await tester.pump();
        expect(find.byType(ToolCell), findsOneWidget);
        await tester.tap(find.text('读取文件'));
        await tester.pump();
        expect(find.byType(StepOutputCard), findsNWidgets(2));
        expect(find.text('Original mobile output'), findsWidgets);
        await show(false);
        expect(find.text('Planning Next Step'), findsNothing);
        expect(find.byType(ToolCell), findsNothing);
        expect(find.text('· 1 tool call'), findsOneWidget);
        await tester.tap(find.textContaining('Worked for'));
        await tester.pump(const Duration(milliseconds: 200));
        expect(find.byType(WorkStageRow), findsOneWidget);
        expect(find.byType(ToolCell), findsNothing);
        await tester.tap(find.text(title));
        await tester.pump();
        await tester.tap(find.text('读取文件'));
        await tester.pump();
        expect(find.byType(StepOutputCard), findsNWidgets(2));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  }
}
