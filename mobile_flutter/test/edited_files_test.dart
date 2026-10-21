import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nekocode_mobile/core/desktop_client.dart';
import 'package:nekocode_mobile/core/protocol.dart';
import 'package:nekocode_mobile/features/chat/edited_files.dart';
import 'package:nekocode_mobile/features/chat/file_changes.dart';
import 'package:nekocode_mobile/features/mobile_controller.dart';
import 'support.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('capsule file list and paged diff (${brightness.name})', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final calls = <Json>[];
      final desktop =
          DesktopClient(
              MemoryStore(),
              httpClient: MockClient((request) async {
                expect(request.method, 'POST');
                expect(request.url.path, '/api/tasks/task-1/checkpoint-diff');
                final body = object(jsonDecode(request.body));
                calls.add(body);
                expect(body['checkpointId'], 'checkpoint-1');
                expect(body['path'], 'src/chat.dart');
                return http.Response(
                  jsonEncode({
                    'path': 'src/chat.dart',
                    'patch': body['offset'] == 0 ? '+new\n' : '-old\n',
                    'offset': body['offset'],
                    'total': 10,
                    'version': 'v1',
                    'binary': false,
                  }),
                  200,
                );
              }),
            )
            ..mode = 'lan'
            ..lan = {'endpoint': 'http://127.0.0.1:47832', 'token': 'test'};
      final c = MobileController(desktop)..taskId = 'task-1';
      addTearDown(c.dispose);
      const changes = TurnChanges(
        checkpointId: 'checkpoint-1',
        promptId: 'u',
        files: [
          ChangedFile('src/chat.dart', 12, 3),
          ChangedFile('test/chat.dart', 4, 2),
        ],
      );
      await tester.pumpWidget(
        themed(
          Scaffold(
            body: EditedFilesCapsule(
              changes: changes,
              controller: c,
              live: true,
            ),
          ),
          brightness: brightness,
        ),
      );
      expect(find.text('2 个文件已修改'), findsOneWidget);
      expect(find.text('+16'), findsOneWidget);
      expect(find.text('−5'), findsOneWidget);
      await tester.tap(find.text('2 个文件已修改'));
      await tester.pumpAndSettle();
      expect(find.text('src/chat.dart'), findsOneWidget);
      expect(find.text('test/chat.dart'), findsOneWidget);
      await tester.tap(find.text('src/chat.dart'));
      await tester.pumpAndSettle();
      expect(find.text('+new'), findsOneWidget);
      await tester.tap(find.text('加载更多差异'));
      await tester.pumpAndSettle();
      expect(calls.last['offset'], 5);
      expect(calls.last['version'], 'v1');
      expect(find.text('-old'), findsOneWidget);
      expect(find.text('加载更多差异'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }
  testWidgets('diff failures retry and binary files do not fabricate patches', (
    tester,
  ) async {
    var requests = 0;
    final desktop =
        DesktopClient(
            MemoryStore(),
            httpClient: MockClient((request) async {
              requests++;
              return requests == 1
                  ? http.Response('{"error":"old desktop"}', 404)
                  : http.Response(
                      jsonEncode({
                        'path': 'logo.png',
                        'patch': '',
                        'offset': 0,
                        'total': 0,
                        'version': 'v1',
                        'binary': true,
                      }),
                      200,
                    );
            }),
          )
          ..mode = 'lan'
          ..lan = {'endpoint': 'http://127.0.0.1:47832', 'token': 'test'};
    final c = MobileController(desktop);
    addTearDown(c.dispose);
    await tester.pumpWidget(
      themed(
        Scaffold(
          body: FileDiffDetails(
            taskId: 't',
            checkpointId: 'cp',
            path: 'logo.png',
            controller: c,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('请更新并重启电脑端'), findsOneWidget);
    await tester.tap(find.text('重试'));
    await tester.pumpAndSettle();
    expect(find.text('二进制文件，不提供文本差异预览。'), findsOneWidget);
    expect(requests, 2);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
