import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nekocode_mobile/core/desktop_client.dart';
import 'package:nekocode_mobile/features/chat/chat_page.dart';
import 'package:nekocode_mobile/features/mobile_controller.dart';
import 'package:nekocode_mobile/ui/glass_page.dart';
import 'support.dart';
import 'package:nekocode_mobile/features/home/welcome_backdrop.dart';

void main() {
  test('halftone remains deterministic and fades before the composer', () {
    expect(WelcomeDotPainter.densityAt(.2), 1);
    expect(
      WelcomeDotPainter.densityAt(.5),
      lessThan(WelcomeDotPainter.densityAt(.4)),
    );
    expect(WelcomeDotPainter.densityAt(.7), 0);
    expect(WelcomeDotPainter.densityAt(1), 0);
    expect(
      const WelcomeDotPainter(
        dark: false,
      ).shouldRepaint(const WelcomeDotPainter(dark: false)),
      isFalse,
    );
    expect(
      const WelcomeDotPainter(
        dark: true,
      ).shouldRepaint(const WelcomeDotPainter(dark: false)),
      isTrue,
    );
  });
  for (final brightness in Brightness.values) {
    testWidgets('home buttons sample wallpaper only (${brightness.name})', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final c = MobileController(DesktopClient(MemoryStore()))
        ..online = true
        ..ready = true
        ..defaults = {};
      var sessions = 0, settings = 0;
      Widget page() => themed(
        ChatPage(
          controller: c,
          home: true,
          onPickProject: () {},
          onPickAgent: () {},
          onSessions: () => sessions++,
          onSettings: () => settings++,
        ),
        brightness: brightness,
      );
      await tester.pumpWidget(page());
      await tester.pumpAndSettle();
      final capture = tester.widget<MiuixLayerBackdropCapture>(
        find.byType(MiuixLayerBackdropCapture),
      );
      expect(capture.child, isA<WelcomeBackdrop>());
      final bar = tester.widget<MiuixGlassTopAppBar>(
        find.byType(MiuixGlassTopAppBar),
      );
      expect(bar.backdrop, same(capture.backdrop));
      expect(bar.backdrop!.snapshot, isNotNull);
      final lenses = tester
          .widgetList<MiuixGlassPanel>(find.byType(MiuixGlassPanel))
          .where((panel) => panel.shading);
      expect(lenses.length, 2);
      for (final lens in lenses) {
        expect(lens.backdrop, same(capture.backdrop));
        expect(lens.style, same(MiuixGlassStyles.commonSmallThin));
      }
      final buttons = find.byType(MiuixGlassIconButton);
      expect(buttons, findsNWidgets(2));
      for (final element in buttons.evaluate()) {
        final panel = tester.widget<MiuixGlassPanel>(
          find
              .descendant(
                of: find.byWidget(element.widget),
                matching: find.byType(MiuixGlassPanel),
              )
              .first,
        );
        expect(panel.backdrop, same(capture.backdrop));
      }
      await tester.tap(find.byTooltip('会话列表'));
      await tester.pumpAndSettle();
      expect(sessions, 1);
      await tester.tap(find.byTooltip('设置'));
      await tester.pumpAndSettle();
      expect(settings, 1);
      c.taskId = 'task-1';
      c.snapshot = {
        'cells': [
          {'id': 'u', 'type': 'user', 'text': '开始任务'},
        ],
        'streaming': false,
      };
      await tester.pumpWidget(page());
      await tester.pumpAndSettle();
      expect(find.byType(MiuixLayerBackdropCapture), findsNothing);
      expect(
        tester
            .widget<MiuixGlassTopAppBar>(find.byType(MiuixGlassTopAppBar))
            .backdrop,
        isNull,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      c.dispose();
    });
  }
  testWidgets('null action remains disabled rather than an enabled no-op', (
    tester,
  ) async {
    await tester.pumpWidget(
      themed(
        Scaffold(
          body: GlassAction(
            icon: MiuixIcons.os4.settings,
            onPressed: null,
            tooltip: 'disabled',
          ),
        ),
      ),
    );
    expect(
      tester
          .widget<MiuixGlassIconButton>(find.byType(MiuixGlassIconButton))
          .onPressed,
      isNull,
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
