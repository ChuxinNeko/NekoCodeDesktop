import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:nekocode_mobile/app.dart';
import 'package:nekocode_mobile/core/storage.dart';

import '../test/extension_dialog_test.dart' as dialogs;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  // These same interactions now run in the real GTK/Flutter desktop window,
  // not flutter_tester's headless rendering process.
  dialogs.main();
  testWidgets('Linux 原生应用启动与系统安全存储读写', (tester) async {
    const store = SecureStore();
    final key = 'desktop-integration-${DateTime.now().microsecondsSinceEpoch}';
    try {
      await store.write(key, 'native-storage-check');
      expect(await store.read(key), 'native-storage-check');
    } finally {
      await store.write(key, null);
    }
    await tester.pumpWidget(const NekoCodeApp());
    await tester.pumpAndSettle();
    expect(find.text('连接桌面，继续你的任务'), findsOneWidget);
    await tester.tap(find.text('手动配置'));
    await tester.pumpAndSettle();
    expect(find.text('绑定电脑'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
