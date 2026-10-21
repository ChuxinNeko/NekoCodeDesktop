import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nekocode_mobile/core/desktop_client.dart';
import 'package:nekocode_mobile/features/mobile_controller.dart';
import 'package:nekocode_mobile/features/settings/settings_page.dart';
import 'support.dart';

void main() {
  for (final scale in [1.0, 1.4, 2.0]) {
    for (final dark in [false, true]) {
      testWidgets('设置标题完整显示 scale=$scale dark=$dark', (tester) async {
        tester.view.physicalSize = const Size(320, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final c = MobileController(DesktopClient(MemoryStore()));
        addTearDown(c.dispose);
        await tester.pumpWidget(
          themed(
            Builder(
              builder: (ctx) => MediaQuery(
                data: MediaQuery.of(
                  ctx,
                ).copyWith(textScaler: TextScaler.linear(scale)),
                child: SettingsPage(controller: c, toggleTheme: () {}),
              ),
            ),
            brightness: dark ? Brightness.dark : Brightness.light,
          ),
        );
        await tester.pumpAndSettle();
        final finder = find.byKey(const ValueKey('settings-large-title'));
        final text = tester.widget<Text>(finder);
        final paragraph = tester.renderObject<RenderParagraph>(finder);
        expect(text.data, '设置');
        expect(text.maxLines, isNull);
        expect(paragraph.didExceedMaxLines, isFalse);
        final rect = tester.getRect(finder);
        expect(rect.top, greaterThanOrEqualTo(48));
        expect(rect.bottom, lessThan(tester.getRect(find.text('账号')).top));
        expect(
          paragraph.size.height,
          greaterThanOrEqualTo(text.style!.fontSize! * scale),
        );
        // Ancestor viewport/capture clips must contain the whole heading.
        for (final element
            in find
                .ancestor(of: finder, matching: find.byType(ClipRect))
                .evaluate()) {
          final box = element.renderObject! as RenderBox;
          final clip = box.localToGlobal(Offset.zero) & box.size;
          expect(clip.top, lessThanOrEqualTo(rect.top));
          expect(clip.bottom, greaterThanOrEqualTo(rect.bottom));
        }
        expect(tester.takeException(), isNull);
      });
    }
  }
}
