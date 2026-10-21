import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nekocode_mobile/core/desktop_client.dart';
import 'package:nekocode_mobile/features/chat/chat_page.dart';
import 'package:nekocode_mobile/features/home/welcome_view.dart';
import 'package:nekocode_mobile/features/mobile_controller.dart';
import 'package:nekocode_mobile/features/sessions/sessions_drawer.dart';

import 'support.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets(
      'keyboard and typing keep home content stable (${brightness.name})',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        tester.view.viewPadding = const FakeViewPadding(bottom: 24);
        tester.view.padding = const FakeViewPadding(bottom: 24);
        addTearDown(tester.view.reset);
        final c = MobileController(DesktopClient(MemoryStore()))
          ..ready = true
          ..online = true
          ..defaults = {};
        await tester.pumpWidget(
          themed(
            ChatPage(
              controller: c,
              home: true,
              onPickProject: () {},
              onPickAgent: () {},
              onSessions: () {},
              onSettings: () {},
            ),
            brightness: brightness,
          ),
        );
        await tester.pumpAndSettle();
        final welcome = tester.widget(find.byType(WelcomeView));
        final input = find.byType(EditableText);
        final initialBottom = tester.getBottomLeft(input).dy;
        final send = find.byWidgetPredicate(
          (widget) => widget is MiuixPressable && widget.semanticLabel == '发送',
        );
        expect(tester.widget<MiuixPressable>(send).onPressed, isNull);
        // Only the static wallpaper is sampled, never the composer or messages.
        final capture = tester.widget<MiuixLayerBackdropCapture>(
          find.byType(MiuixLayerBackdropCapture),
        );
        expect(capture.child, isA<WelcomeBackdrop>());
        expect(
          find.descendant(
            of: find.byType(MiuixLayerBackdropCapture),
            matching: find.byType(EditableText),
          ),
          findsNothing,
        );
        expect(capture.backdrop.snapshot, isNotNull);
        await tester.tap(input);
        for (final inset in [60.0, 140.0, 240.0, 320.0, 160.0, 0.0]) {
          tester.view.viewInsets = FakeViewPadding(bottom: inset);
          tester.view.padding = FakeViewPadding(bottom: inset > 0 ? 0 : 24);
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 16));
          expect(tester.widget(find.byType(WelcomeView)), same(welcome));
          expect(
            tester.getBottomLeft(input).dy,
            closeTo(initialBottom - (inset > 0 ? inset - 24 : 0), 1),
          );
          expect(tester.takeException(), isNull);
        }
        await tester.enterText(input, '修复键盘动画');
        await tester.pump();
        expect(tester.widget(find.byType(WelcomeView)), same(welcome));
        expect(tester.widget<MiuixPressable>(send).onPressed, isNotNull);
        final currentCapture = tester.widget<MiuixLayerBackdropCapture>(
          find.byType(MiuixLayerBackdropCapture),
        );
        expect(currentCapture.backdrop, same(capture.backdrop));
        await tester.enterText(input, '');
        await tester.pump();
        expect(tester.widget<MiuixPressable>(send).onPressed, isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        c.dispose();
      },
    );
  }

  testWidgets('closing the session drawer does not reopen the keyboard', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final c = MobileController(DesktopClient(MemoryStore()))
      ..ready = true
      ..online = true
      ..defaults = {};
    await tester.pumpWidget(
      themed(
        Builder(
          builder: (context) => ChatPage(
            controller: c,
            home: true,
            onPickProject: () {},
            onPickAgent: () {},
            onSessions: () =>
                showSessionsDrawer(context, controller: c, onSettings: () {}),
            onSettings: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(EditableText));
    await tester.pump();
    expect(tester.testTextInput.isVisible, isTrue);

    await tester.tap(find.byTooltip('会话列表'));
    await tester.pumpAndSettle();
    expect(find.text('会话'), findsWidgets);

    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();
    expect(tester.testTextInput.isVisible, isFalse);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
    c.dispose();
  });
}
