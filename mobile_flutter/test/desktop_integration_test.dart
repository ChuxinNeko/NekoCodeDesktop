import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nekocode_mobile/core/desktop_client.dart';
import 'package:nekocode_mobile/core/protocol.dart';

import 'support.dart';

void main() {
  final endpoint = Platform.environment['NEKOCODE_TEST_ENDPOINT'];
  test(
    'Dart 客户端 -> 真实 LanService 配对/状态/创建/增量/消息/取消/撤销',
    () async {
      final desktop = DesktopClient(MemoryStore());
      addTearDown(desktop.dispose);
      await desktop.pair(
        endpoint!,
        Platform.environment['NEKOCODE_TEST_CODE']!,
        'Flutter integration',
      );
      final state = await desktop.state();
      final project = records(state['projects']).single;
      expect(records(state['tasks']).single['title'], 'Desktop task');
      expect(
        records(state['tasks']).single.containsKey('sessionFile'),
        isFalse,
      );
      expect((await desktop.defaults(project['id'] as String))['mode'], 'auto');
      final created = await desktop.submit('/api/tasks', {
        'projectId': project['id'],
        'text': 'Flutter 集成测试',
        'options': {'mode': 'read-only'},
      });
      expect(created['accepted'], isTrue);
      final id = created['id'] as String;
      final first = await desktop.sync(id);
      expect(records(first['cells']).first['text'], '初始消息');
      await desktop.submit('/api/tasks/$id/send', {'text': '继续执行'});
      final next = await desktop.sync(id);
      expect(records(next['cells']).last['text'], '继续执行');
      await desktop.taskAction(id, 'configure', {'thinkingLevel': 'high'});
      expect((await desktop.sync(id))['thinkingLevel'], 'high');
      expect((await desktop.taskAction(id, 'abort', {}))['streaming'], isFalse);
      expect(
        (await desktop.request('/api/tasks/$id/commands') as List).length,
        1,
      );
      final acp = object(await desktop.request('/api/acp/state'));
      expect(records(acp['agents']).single['enabled'], isTrue);
      final session = object(
        await desktop.request('/api/acp/sessions', {
          'agentId': 'codex',
          'projectId': project['id'],
        }),
      );
      await desktop.submit('/api/acp/sessions/${session['id']}/prompt', {
        'text': 'ACP hello',
      });
      final view = object(
        await desktop.request('/api/acp/sessions/${session['id']}'),
      );
      expect(records(view['cells']).last['text'], 'ACP hello');
      await desktop.acpAction(session['id'] as String, 'permission', {
        'requestId': 'permission-1',
        'optionId': 'allow',
      });
      await desktop.acpAction(session['id'] as String, 'config', {
        'configId': 'model',
        'value': 'test',
      });
      await desktop.acpAction(session['id'] as String, 'cancel', {});
    },
    skip: endpoint == null
        ? '通过 scripts/test-desktop-integration.ts 启动真实 LAN 路由测试'
        : false,
  );
}
