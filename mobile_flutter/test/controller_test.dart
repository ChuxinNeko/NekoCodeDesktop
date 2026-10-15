import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nekocode_mobile/core/desktop_client.dart';
import 'package:nekocode_mobile/features/mobile_controller.dart';

import 'support.dart';

void main() {
  test('ACP 503 不阻断主连接、任务与聊天，并在服务恢复后重新发现代理', () async {
    var available = false;
    final desktop =
        DesktopClient(
            MemoryStore(),
            httpClient: MockClient((request) async {
              if (request.url.path == '/api/acp/state') {
                return available
                    ? http.Response(
                        '{"agents":[{"id":"codex","enabled":true}],"sessions":[]}',
                        200,
                      )
                    : http.Response(
                        jsonEncode({'error': 'ACP 服务尚未就绪'}),
                        503,
                        headers: {
                          'content-type': 'application/json; charset=utf-8',
                        },
                      );
              }
              if (request.url.path == '/api/state') {
                return http.Response(
                  '{"projects":[],"tasks":[{"id":"t","title":"Task"}]}',
                  200,
                );
              }
              if (request.url.path.endsWith('/delta')) {
                return http.Response(
                  '{"version":"v","full":{"cells":[{"id":"c","type":"assistant","text":"reply"}],"models":[],"checkpoints":[]}}',
                  200,
                );
              }
              return http.Response('{}', 200);
            }),
          )
          ..mode = 'lan'
          ..lan = {'endpoint': 'http://127.0.0.1:47832', 'token': 'test'};
    final c = MobileController(desktop);
    await c.refresh();
    expect(c.online, isTrue, reason: 'ACP 不是主连接的可用性条件');
    expect(c.tasks.single['id'], 't');
    c.view = 'chat';
    c.taskId = 't';
    await c.refresh();
    expect(c.snapshot?['cells'], isNotEmpty);
    expect(c.online, isTrue);
    available = true;
    await c.refresh();
    expect(c.enabledAgents.single['id'], 'codex');
    c.dispose();
  });
  test('真实控制器新建任务/配置/发送/停止/历史、401 移除绑定', () async {
    final calls = <String>[];
    var invalid = false;
    final snapshot = <String, dynamic>{
      'session': {'id': 'task-1', 'cwd': '/project'},
      'cells': [],
      'models': [],
      'checkpoints': [],
      'workflow': {'request': null, 'todos': [], 'tasks': []},
      'streaming': false,
    };
    final desktop =
        DesktopClient(
            MemoryStore(),
            httpClient: MockClient((request) async {
              calls.add(request.url.path);
              if (invalid) return http.Response('{"error":"expired"}', 401);
              dynamic value;
              switch (request.url.path) {
                case '/api/state':
                  value = {
                    'projects': [
                      {'id': 'p1', 'name': 'demo', 'path': '/project'},
                    ],
                    'tasks': [
                      {'id': 'task-1', 'title': 'Task', 'cwd': '/project'},
                    ],
                  };
                case '/api/acp/state':
                  value = {'agents': [], 'sessions': []};
                case '/api/projects/p1/defaults':
                  value = {
                    'mode': 'auto',
                    'workMode': 'agent',
                    'modelKey': 'm1',
                    'models': [],
                    'thinkingLevels': ['off'],
                    'thinkingLevel': 'off',
                  };
                case '/api/tasks':
                  value = {'id': 'task-1', 'accepted': true};
                case '/api/tasks/task-1/send':
                  value = {'accepted': true};
                case '/api/tasks/task-1/delta':
                  value = {'version': '1', 'full': snapshot, 'more': true};
                default:
                  value = snapshot;
              }
              return http.Response(
                jsonEncode(value),
                200,
                headers: {'content-type': 'application/json; charset=utf-8'},
              );
            }),
          )
          ..mode = 'lan'
          ..lan = {'endpoint': 'http://127.0.0.1:47832', 'token': 'test'};
    final c = MobileController(desktop);
    await c.refresh();
    expect(c.online, isTrue);
    expect(c.projectId, 'p1');
    await c.newTask(project: 'p1');
    expect(c.view, 'chat');
    expect(c.defaults?['mode'], 'auto');
    await c.configure({'mode': 'read-only'});
    expect(c.defaults?['mode'], 'read-only');
    expect(await c.send('implement it'), isTrue);
    expect(c.taskId, 'task-1');
    while (c.refreshing) {
      await Future<void>.delayed(Duration.zero);
    }
    await c.earlier();
    expect(desktop.more, isTrue);
    await c.abort();
    expect(calls, contains('/api/tasks/task-1/abort'));
    invalid = true;
    await c.refresh();
    expect(c.paired, isFalse);
    expect(desktop.lan, isNull);
    c.dispose();
  });
}
