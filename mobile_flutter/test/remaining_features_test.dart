import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nekocode_mobile/core/desktop_client.dart';
import 'package:nekocode_mobile/features/mobile_controller.dart';
import 'package:nekocode_mobile/features/chat/run_details.dart';
import 'package:nekocode_mobile/features/chat/team_thread.dart';
import 'package:nekocode_mobile/features/chat/configuration.dart';
import 'package:nekocode_mobile/ui/theme.dart';

import 'support.dart';

void main() {
  test('Team 事件投影保留分配、成员流式输出、工具状态与错误', () {
    final items = projectTeamItems([
      {'type': 'task.started', 'role': 'main', 'task': '@Admin'},
      {'type': 'session.output.delta', 'delta': '分配工作'},
      {
        'type': 'tool.started',
        'role': 'main',
        'toolName': 'team_assign',
        'input': {
          'assignments': [
            {'member': 'Worker', 'task': '实现功能'},
          ],
        },
      },
      {
        'type': 'task.started',
        'role': 'sidekick',
        'workerId': 'w1',
        'task': '@Worker: implement',
        'model': 'm1',
      },
      {'type': 'task.output.delta', 'workerId': 'w1', 'delta': '执行中'},
      {
        'type': 'tool.started',
        'workerId': 'w1',
        'toolCallId': 't1',
        'toolName': 'read',
        'input': {'path': 'a.dart'},
      },
      {'type': 'tool.completed', 'workerId': 'w1', 'toolCallId': 't1'},
      {'type': 'task.failed', 'workerId': 'w1', 'message': '失败原因'},
    ]);
    expect(items.where((i) => i['kind'] == 'assign').single['task'], '实现功能');
    final worker = items.where((i) => i['member'] == 'Worker').single;
    expect(worker['text'], '执行中');
    expect(worker['status'], 'failed');
    expect((worker['tools'] as List).single['status'], 'done');
  });
  testWidgets('扩展 widgets/status/working 与远端等待提示', (tester) async {
    final ui = {
      'dialog': {'id': 'd'},
      'widgets': [
        {
          'key': 'a',
          'lines': ['上方信息'],
          'placement': 'aboveEditor',
        },
        {
          'key': 'b',
          'lines': ['下方信息'],
          'placement': 'belowEditor',
        },
      ],
      'statuses': [
        {'key': 's', 'text': '插件状态'},
      ],
      'working': '正在工作',
    };
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              ExtensionWidgets(ui: ui, below: false, streaming: true),
              ExtensionWidgets(ui: ui, below: true),
            ],
          ),
        ),
      ),
    );
    expect(find.text('上方信息'), findsOneWidget);
    expect(find.text('下方信息'), findsOneWidget);
    expect(find.text('插件状态'), findsOneWidget);
    expect(find.text('正在工作'), findsOneWidget);
    expect(find.textContaining('请在电脑端继续'), findsOneWidget);
  });
  testWidgets('Fusion 自适应路由实际写入新会话配置', (tester) async {
    final c = MobileController(DesktopClient(MemoryStore()))..online = true;
    c.defaults = {
      'modelKey': 'm',
      'thinkingLevel': 'off',
      'models': [
        {
          'key': 'm',
          'name': 'Model',
          'thinkingLevels': ['off', 'high'],
        },
      ],
      'thinkingLevels': ['off'],
    };
    await tester.pumpWidget(
      MaterialApp(
        theme: GptTheme.light(),
        home: Scaffold(body: FusionDialog(controller: c)),
      ),
    );
    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();
    await tester.tap(find.text('应用'));
    await tester.pumpAndSettle();
    expect((c.defaults!['fusion'] as Map)['adaptiveRouting'], true);
    expect((c.defaults!['fusion'] as Map)['leadModelKey'], 'm');
    await tester.pumpWidget(const SizedBox.shrink());
    c.dispose();
  });
}
