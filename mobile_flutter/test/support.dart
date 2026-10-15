import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';
import 'package:nekocode_mobile/ui/theme.dart';
import 'package:nekocode_mobile/core/storage.dart';

class MemoryStore implements Store {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String? value) async {
    if (value == null) {
      values.remove(key);
    } else {
      values[key] = value;
    }
  }
}

/// 把被测组件包进与真实应用一致的 Miuix + Material 主题。
Widget themed(Widget child, {Brightness brightness = Brightness.light}) {
  final dark = brightness == Brightness.dark;
  return MiuixTheme(
    data: dark ? MiuixThemeData.dark() : MiuixThemeData.light(),
    child: MaterialApp(theme: nekoMaterialTheme(brightness), home: child),
  );
}
