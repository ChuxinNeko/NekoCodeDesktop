import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

/// HyperOS 4 / Miuix 设计令牌入口。
///
/// 颜色、字号全部来自 flutter_miuix 的 [MiuixTheme]，业务代码只通过
/// `context.mx` / `context.isDark` 取值，不再硬编码任何色值。
extension NekoContext on BuildContext {
  MiuixColors get mx => MiuixTheme.of(this).colors;
  MiuixTextStyles get mxText => MiuixTheme.of(this).textStyles;
  bool get isDark => mx.surface.computeLuminance() < .5;
}

/// Miuix 色板之外的语义色（成功/警告/代码底色等）。
abstract final class NekoTone {
  static Color success(bool dark) =>
      dark ? const Color(0xFF32D74B) : const Color(0xFF1FB45A);
  static Color warning(bool dark) =>
      dark ? const Color(0xFFFFB340) : const Color(0xFFF08A00);

  /// 代码块 / 终端输出底色：比卡片再低一档的中性灰。
  static Color codeBackground(bool dark) =>
      dark ? const Color(0xFF161616) : const Color(0xFFF2F3F5);
}

/// 形状常量：HyperOS 使用连续曲率（超椭圆）圆角。
abstract final class NekoShape {
  static const double card = 20;
  static const double control = 16;
  static const double bubble = 22;
  static const double chip = 14;

  static ShapeBorder squircle(
    double radius, {
    BorderSide side = BorderSide.none,
  }) => MiuixSquircleBorder(cornerRadius: radius, side: side);
}

/// 间距常量（4 的倍数）。
abstract final class NekoGap {
  static const double page = 12; // 卡片距屏幕边缘
  static const double inner = 16; // 卡片内边距
}

/// 让 Material 控件（SnackBar、Selection、少量遗留控件）与 Miuix 保持一致。
ThemeData nekoMaterialTheme(Brightness brightness) {
  final miuix = brightness == Brightness.dark
      ? MiuixThemeData.dark()
      : MiuixThemeData.light();
  final c = miuix.colors;
  final scheme =
      ColorScheme.fromSeed(
        seedColor: c.primary,
        brightness: brightness,
      ).copyWith(
        primary: c.primary,
        onPrimary: c.onPrimary,
        error: c.error,
        surface: c.surface,
        onSurface: c.onSurface,
        surfaceContainerHighest: c.surfaceContainerHigh,
        outline: c.outline,
        outlineVariant: c.dividerLine,
      );
  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: c.surface,
    canvasColor: c.surface,
    splashFactory: NoSplash.splashFactory,
    highlightColor: Colors.transparent,
    hoverColor: Colors.transparent,
    dividerColor: c.dividerLine,
    visualDensity: VisualDensity.standard,
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: {
        TargetPlatform.android: CupertinoPageTransitionsBuilder(),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.linux: CupertinoPageTransitionsBuilder(),
        TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.windows: CupertinoPageTransitionsBuilder(),
      },
    ),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: c.primary,
      selectionColor: c.primary.withValues(alpha: .28),
      selectionHandleColor: c.primary,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: c.surfaceContainerHigh,
      contentTextStyle: TextStyle(color: c.onSurface, fontSize: 14),
      shape: MiuixSquircleBorder(cornerRadius: 18),
    ),
  );
}
