import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
        theme: nekoMaterialTheme(Brightness.light),
        darkTheme: nekoMaterialTheme(Brightness.dark),
        themeMode: appearance == null
            ? ThemeMode.system
            : (isDark ? ThemeMode.dark : ThemeMode.light),
        builder: (context, child) => AnnotatedRegion<SystemUiOverlayStyle>(
          value: SystemUiOverlayStyle(
            statusBarColor: Colors.transparent,
            systemNavigationBarColor: Colors.transparent,
            systemNavigationBarContrastEnforced: false,
            statusBarIconBrightness: isDark
                ? Brightness.light
                : Brightness.dark,
            statusBarBrightness: isDark ? Brightness.dark : Brightness.light,
            systemNavigationBarIconBrightness: isDark
                ? Brightness.light
                : Brightness.dark,
          ),
          // 页面背景层默认文字色，避免暗色下 MiuixText 回退到黑色。
          child: MiuixContentColor(
            color: MiuixTheme.of(context).colors.onSurface,
            child: child ?? const SizedBox.shrink(),
          ),
        ),
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
