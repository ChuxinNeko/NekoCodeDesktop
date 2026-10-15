import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nekocode_mobile/core/protocol.dart';
import 'package:nekocode_mobile/features/chat/extension_dialog.dart';
import 'package:nekocode_mobile/ui/theme.dart';

void main() {
  Widget page(Json dialog, Future<void> Function(Json) answer) => MaterialApp(
    theme: GptTheme.light(),
    home: Scaffold(
      body: SingleChildScrollView(
        child: ExtensionDialogCard(
          key: ValueKey(dialog['id']),
          dialog: dialog,
          queued: 2,
          onAnswer: answer,
        ),
      ),
    ),
  );
  testWidgets('选择、拒绝、取消分别提交正确字段，队列切换更新草稿', (tester) async {
    final answers = <Json>[];
    Future<void> answer(Json a) async {
      answers.add(a);
    }

    await tester.pumpWidget(
      page({
        'id': 'select',
        'kind': 'select',
        'title': '选择',
        'options': ['A', 'B'],
      }, answer),
    );
    await tester.tap(find.text('B'));
    await tester.pumpAndSettle();
    expect(answers.last, {'id': 'select', 'value': 'B'});
    expect(find.text('另有 2 项等待回答'), findsOneWidget);
    await tester.pumpWidget(
      page({
        'id': 'confirm',
        'kind': 'confirm',
        'title': '确认操作',
        'message': '执行吗？',
      }, answer),
    );
    await tester.tap(find.text('拒绝'));
    await tester.pumpAndSettle();
    expect(answers.last, {'id': 'confirm', 'confirmed': false});
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(answers.last, {'id': 'confirm', 'cancelled': true});
    await tester.pumpWidget(
      page({
        'id': 'editor',
        'kind': 'editor',
        'title': '编辑',
        'prefill': '预填内容',
      }, answer),
    );
    expect(find.text('预填内容'), findsOneWidget);
    await tester.enterText(find.byType(EditableText), '第一行\n第二行');
    await tester.tap(find.text('提交'));
    await tester.pumpAndSettle();
    expect(answers.last, {'id': 'editor', 'value': '第一行\n第二行'});
    await tester.pumpWidget(
      page({'id': 'input', 'kind': 'input', 'title': '输入'}, answer),
    );
    expect(find.text('第一行\n第二行'), findsNothing);
    await tester.tap(find.text('提交'));
    await tester.pumpAndSettle();
    expect(answers.last, {'id': 'input', 'value': ''});
  });
  testWidgets('失败保留输入并允许重试，不将取消误提交为确认', (tester) async {
    var attempts = 0;
    await tester.pumpWidget(
      page({'id': 'd', 'kind': 'input', 'title': '输入'}, (a) async {
        attempts++;
        if (attempts == 1) throw ApiError('网络中断');
        expect(a, {'id': 'd', 'value': '保留草稿'});
      }),
    );
    await tester.enterText(find.byType(EditableText), '保留草稿');
    await tester.tap(find.text('提交'));
    await tester.pumpAndSettle();
    expect(find.text('网络中断'), findsOneWidget);
    expect(find.text('保留草稿'), findsOneWidget);
    await tester.tap(find.text('提交'));
    await tester.pumpAndSettle();
    expect(attempts, 2);
    expect(find.text('网络中断'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
