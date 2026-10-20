import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:nekocode_mobile/app.dart';
import 'package:nekocode_mobile/core/desktop_client.dart';
import 'package:nekocode_mobile/features/mobile_controller.dart';

import 'support.dart';

/// 运行中的任务带有持续动画，pumpAndSettle 永远不会结束，改为固定时长推进。
Future<void> settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 800));
}

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('真实配对页面 ${brightness.name}、手动及账号切换', (tester) async {
      SharedPreferences.setMockInitialValues({});
      tester.platformDispatcher.platformBrightnessTestValue = brightness;
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final c = MobileController(DesktopClient(MemoryStore()))..ready = true;
      await tester.pumpWidget(NekoCodeApp(controller: c, initialize: false));
      await tester.pumpAndSettle();
      expect(find.text('扫一扫，连接电脑'), findsOneWidget);
      await tester.tap(find.text('手动配置'));
      await tester.pumpAndSettle();
      expect(find.text('绑定电脑'), findsOneWidget);
      await tester.tap(find.text('公网连接'));
      await tester.pumpAndSettle();
      expect(find.text('登录 NekoCode'), findsWidgets);
      await tester.ensureVisible(find.text('注册账号'));
      await tester.tap(find.text('注册账号'));
      await tester.pumpAndSettle();
      expect(find.text('确认密码'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      c.dispose();
    });
  }
  testWidgets('任务分组、真实聊天内容、配置和工作流呈现', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final desktop = DesktopClient(MemoryStore())
      ..mode = 'lan'
      ..lan = {
        'name': '测试电脑',
        'endpoint': 'http://127.0.0.1:47832',
        'token': 'test',
      };
    final c = MobileController(desktop)
      ..ready = true
      ..online = true;
    c.tasks = [
      {
        'id': 'task-1',
        'title': '真实任务',
        'cwd': '/workspace/demo',
        'running': true,
        'updatedAt': 1,
      },
    ];
    await tester.pumpWidget(NekoCodeApp(controller: c, initialize: false));
    await settle(tester);
    // 首页是欢迎页，会话列表收在左上角抽屉里。
    expect(find.text('NekoCode'), findsWidgets);
    expect(find.text('真实任务'), findsNothing);
    await tester.tap(find.byTooltip('会话列表'));
    await settle(tester);
    expect(find.text('真实任务'), findsOneWidget);
    expect(find.byTooltip('新建会话'), findsOneWidget);
    expect(find.bySemanticsLabel('添加附件'), findsOneWidget);
    await tester.tapAt(const Offset(780, 400));
    await settle(tester);
    expect(find.text('真实任务'), findsNothing);
    await tester.tap(find.byTooltip('设置'));
    await settle(tester);
    expect(find.text('深色模式'), findsOneWidget);
    await tester.tap(find.byTooltip('返回'));
    await settle(tester);
    c.view = 'chat';
    c.taskId = 'task-1';
    c.snapshot = {
      'cells': [
        {'id': '1', 'type': 'user', 'text': '请修复问题'},
        {'id': '2', 'type': 'assistant', 'text': '已经定位到问题', 'thinking': '分析过程'},
      ],
      'workflow': {
        'request': {
          'id': 'q1',
          'title': '确认方案',
          'questions': [
            {
              'id': 'q',
              'question': '选择方案',
              'options': [
                {'id': 'a', 'label': '方案 A'},
              ],
            },
          ],
        },
      },
      'models': [],
      'thinkingLevels': ['off'],
    };
    c.emit();
    await settle(tester);
    expect(find.text('确认方案'), findsOneWidget);
    expect(find.text('方案 A'), findsOneWidget);
    await tester.drag(find.byType(ListView).first, const Offset(0, 1000));
    await settle(tester);
    expect(find.textContaining('请修复问题', findRichText: true), findsWidgets);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    c.dispose();
  });
}
