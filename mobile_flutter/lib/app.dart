import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/desktop_client.dart';
import 'core/storage.dart';
import 'features/mobile_controller.dart';
import 'features/mobile_shell.dart';
import 'ui/theme.dart';

class NekoCodeApp extends StatefulWidget {
  const NekoCodeApp({super.key, this.controller, this.initialize = true});
  final MobileController? controller;
  final bool initialize;
  @override
  State<NekoCodeApp> createState() => _NekoCodeAppState();
}

class _NekoCodeAppState extends State<NekoCodeApp> {
  late final MobileController controller;
  Brightness? appearance;
  @override
  void initState() {
    super.initState();
    controller =
        widget.controller ??
        MobileController(DesktopClient(const SecureStore()));
    _restoreTheme();
  }

  Future<void> _restoreTheme() async {
    final prefs = await SharedPreferences.getInstance();
    final value = prefs.getString('appearance');
    if (mounted && value != null) {
      setState(
        () => appearance = value == 'dark' ? Brightness.dark : Brightness.light,
      );
    }
  }

  Future<void> toggleTheme() async {
    final current = appearance ?? MediaQuery.platformBrightnessOf(context);
    setState(
      () => appearance = current == Brightness.dark
          ? Brightness.light
          : Brightness.dark,
    );
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('appearance', appearance!.name);
  }

  @override
  void dispose() {
    if (widget.controller == null) controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final platformBrightness = MediaQuery.platformBrightnessOf(context);
    final brightness = appearance ?? platformBrightness;
    final isDark = brightness == Brightness.dark;

    return MiuixTheme(
      data: isDark ? MiuixThemeData.dark() : MiuixThemeData.light(),
      child: MaterialApp(
        title: 'NekoCode',
        debugShowCheckedModeBanner: false,
        theme: GptTheme.light(),
        darkTheme: GptTheme.dark(),
        themeMode: appearance == null
            ? ThemeMode.system
            : (isDark ? ThemeMode.dark : ThemeMode.light),
        home: MobileShell(
          controller: controller,
          initialize: widget.initialize,
          dark: isDark,
          toggleTheme: toggleTheme,
        ),
      ),
    );
  }
}
