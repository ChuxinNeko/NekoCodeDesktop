import 'package:flutter/material.dart';

/// BaoCode & VS Code 风格调色规范与 Tokens
abstract final class BaoColors {
  // Dark mode (VS Code Dark+ & BaoCode Workbench)
  static const darkMainBg = Color(0xFF1F1F1F); // editor.background
  static const darkSidebarBg = Color(0xFF181818); // sideBar.background
  static const darkSurface = Color(0xFF202020); // editorWidget.background
  static const darkSurfaceHover = Color(0xFF282828);
  static const darkBorder = Color(0xFF2B2B2B); // panel.border / sideBar.border
  static const darkBorderSubtle = Color(0xFF333333);
  static const darkTextPrimary = Color(0xFFF2F2F2); // 高亮主文字
  static const darkText = Color(0xFFCCCCCC); // VS Code 默认 foreground
  static const darkTextSecondary = Color(0xFF8C8C8C); // VS Code textMuted
  static const darkTextFaint = Color(0xFF656565); // VS Code textFaint
  static const darkBubbleFill = Color(0xFF262626); // agentsChatInput / 用户气泡背景
  static const darkBubbleBorder = Color(0xFF383838); // 气泡精细边框
  static const darkInputBg = Color(0xFF252525); // input.background
  static const darkInputBorder = Color(0xFF3C3C3C); // input.border
  static const darkCodeBg = Color(0xFF141414); // 终端与代码内衬黑底

  // Light mode (VS Code Light+)
  static const lightMainBg = Color(0xFFFFFFFF);
  static const lightSidebarBg = Color(0xFFF8F8F8);
  static const lightSurface = Color(0xFFF3F3F3);
  static const lightSurfaceHover = Color(0xFFE8E8E8);
  static const lightBorder = Color(0xFFE5E5E5);
  static const lightBorderSubtle = Color(0xFFD4D4D4);
  static const lightTextPrimary = Color(0xFF1F1F1F);
  static const lightText = Color(0xFF3B3B3B);
  static const lightTextSecondary = Color(0xFF616161);
  static const lightTextFaint = Color(0xFF8C8C8C);
  static const lightBubbleFill = Color(0xFFF4F4F4);
  static const lightBubbleBorder = Color(0xFFE0E0E0);
  static const lightInputBg = Color(0xFFF8F8F8);
  static const lightInputBorder = Color(0xFFCECECE);
  static const lightCodeBg = Color(0xFFF0F0F0);

  // VS Code Accent / Status (BaoCode 规范)
  static const accent = Color(0xFF0078D4); // activityBarBadge / button.background
  static const accentHover = Color(0xFF026EC1);
  static const accentMuted = Color(0xFF264778);
  static const amber = Color(0xFFD29922); // 思考 / Warning
  static const green = Color(0xFF2EA043); // editorGutter.addedBackground / Success
  static const red = Color(0xFFF85149); // editorGutter.deletedBackground / Error
  static const blueMuted = Color(0xFF85B6FF);
}

/// 兼容别名，保留现有项目可能直接引用的字段名
typedef GptColors = BaoColors;

extension BaoColorsCompat on BaoColors {
  static const primary = BaoColors.accent;
  static const primaryDark = BaoColors.accentHover;
  static const accentOrange = BaoColors.amber;
  static const accentGreen = BaoColors.green;
  static const error = BaoColors.red;
  static const warning = BaoColors.amber;
  static const success = BaoColors.green;
  static const darkUserBubble = BaoColors.darkBubbleFill;
  static const lightUserBubble = BaoColors.lightBubbleFill;
}

/// BaoCode 现代化暗黑工作台主题体系
class BaoTheme {
  static ThemeData dark() {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: BaoColors.darkMainBg,
      primaryColor: BaoColors.accent,
      canvasColor: BaoColors.darkSidebarBg,
      colorScheme: const ColorScheme.dark(
        primary: BaoColors.accent,
        onPrimary: Colors.white,
        surface: BaoColors.darkMainBg,
        onSurface: BaoColors.darkTextPrimary,
        surfaceContainerHighest: BaoColors.darkBubbleFill,
        outline: BaoColors.darkBorder,
        outlineVariant: BaoColors.darkBorderSubtle,
        error: BaoColors.red,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: BaoColors.darkSidebarBg,
        foregroundColor: BaoColors.darkTextPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: true,
        titleTextStyle: TextStyle(
          color: BaoColors.darkTextPrimary,
          fontSize: 15,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.2,
        ),
      ),
      drawerTheme: const DrawerThemeData(
        backgroundColor: BaoColors.darkSidebarBg,
        elevation: 0,
        shape: RoundedRectangleBorder(
          side: BorderSide(color: BaoColors.darkBorder, width: 0.8),
        ),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: BaoColors.darkSidebarBg,
        selectedItemColor: BaoColors.darkTextPrimary,
        unselectedItemColor: BaoColors.darkTextSecondary,
        selectedLabelStyle: TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
        unselectedLabelStyle: TextStyle(fontSize: 11),
        type: BottomNavigationBarType.fixed,
        elevation: 0,
      ),
      cardTheme: CardThemeData(
        color: BaoColors.darkSurface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: BaoColors.darkBorder, width: 0.8),
          borderRadius: BorderRadius.circular(8),
        ),
      ),
      dividerTheme: const DividerThemeData(
        color: BaoColors.darkBorder,
        thickness: 0.8,
        space: 1,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: BaoColors.darkInputBg,
        hintStyle: const TextStyle(color: BaoColors.darkTextSecondary, fontSize: 13.5),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: BaoColors.darkInputBorder, width: 0.8),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: BaoColors.darkInputBorder, width: 0.8),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: BaoColors.accent, width: 1.2),
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      ),
    );
  }

  static ThemeData light() {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      scaffoldBackgroundColor: BaoColors.lightMainBg,
      primaryColor: BaoColors.accent,
      canvasColor: BaoColors.lightSidebarBg,
      colorScheme: const ColorScheme.light(
        primary: BaoColors.accent,
        onPrimary: Colors.white,
        surface: BaoColors.lightMainBg,
        onSurface: BaoColors.lightTextPrimary,
        surfaceContainerHighest: BaoColors.lightBubbleFill,
        outline: BaoColors.lightBorder,
        outlineVariant: BaoColors.lightBorderSubtle,
        error: BaoColors.red,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: BaoColors.lightSidebarBg,
        foregroundColor: BaoColors.lightTextPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: true,
        titleTextStyle: TextStyle(
          color: BaoColors.lightTextPrimary,
          fontSize: 15,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.2,
        ),
      ),
      drawerTheme: const DrawerThemeData(
        backgroundColor: BaoColors.lightSidebarBg,
        elevation: 0,
        shape: RoundedRectangleBorder(
          side: BorderSide(color: BaoColors.lightBorder, width: 0.8),
        ),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: BaoColors.lightSidebarBg,
        selectedItemColor: BaoColors.lightTextPrimary,
        unselectedItemColor: BaoColors.lightTextSecondary,
        selectedLabelStyle: TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
        unselectedLabelStyle: TextStyle(fontSize: 11),
        type: BottomNavigationBarType.fixed,
        elevation: 0,
      ),
      cardTheme: CardThemeData(
        color: BaoColors.lightSurface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: BaoColors.lightBorder, width: 0.8),
          borderRadius: BorderRadius.circular(8),
        ),
      ),
      dividerTheme: const DividerThemeData(
        color: BaoColors.lightBorder,
        thickness: 0.8,
        space: 1,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: BaoColors.lightInputBg,
        hintStyle: const TextStyle(color: BaoColors.lightTextSecondary, fontSize: 13.5),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: BaoColors.lightInputBorder, width: 0.8),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: BaoColors.lightInputBorder, width: 0.8),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: BaoColors.accent, width: 1.2),
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      ),
    );
  }
}

/// 兼容别名
typedef GptTheme = BaoTheme;
