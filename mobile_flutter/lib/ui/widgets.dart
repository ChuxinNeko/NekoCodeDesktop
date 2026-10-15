import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'theme.dart';

/// BaoCode & VS Code 风格操作按钮
class ActionButton extends StatelessWidget {
  const ActionButton(
    this.label, {
    super.key,
    required this.onPressed,
    this.icon,
    this.isPrimary = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool isPrimary;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    final primaryBg = BaoColors.accent;
    final primaryFg = Colors.white;

    final secondaryBg = isDark ? const Color(0xFF313131) : const Color(0xFFE5E5E5);
    final secondaryFg = isDark ? BaoColors.darkText : BaoColors.lightText;
    final secondaryBorder = isDark ? const Color(0xFF3C3C3C) : const Color(0xFFCECECE);

    final style = FilledButton.styleFrom(
      backgroundColor: isPrimary ? primaryBg : secondaryBg,
      foregroundColor: isPrimary ? primaryFg : secondaryFg,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(6),
        side: isPrimary ? BorderSide.none : BorderSide(color: secondaryBorder, width: 0.8),
      ),
      textStyle: const TextStyle(fontWeight: FontWeight.w500, fontSize: 13),
    );

    if (icon != null) {
      return FilledButton.icon(
        onPressed: onPressed,
        icon: Icon(icon, size: 16),
        label: Text(label),
        style: style,
      );
    }
    return FilledButton(
      onPressed: onPressed,
      style: style,
      child: Text(label),
    );
  }
}

/// BaoCode 风格工具/推理折叠头 (StepHeader)
class StepHeader extends StatelessWidget {
  const StepHeader({
    super.key,
    required this.verb,
    this.object = '',
    this.detail,
    this.running = false,
    this.expanded = false,
    this.onToggle,
    this.icon,
    this.trailing,
    this.bold = false,
  });

  final String verb;
  final String object;
  final String? detail;
  final bool running;
  final bool expanded;
  final VoidCallback? onToggle;
  final Widget? icon;
  final Widget? trailing;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return InkWell(
      onTap: onToggle,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: Row(
          children: [
            // 折叠箭头或运行中指示
            if (running)
              const SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(
                  strokeWidth: 1.8,
                  valueColor: AlwaysStoppedAnimation<Color>(BaoColors.accent),
                ),
              )
            else if (onToggle != null)
              Icon(
                expanded ? Icons.keyboard_arrow_down_rounded : Icons.chevron_right_rounded,
                size: 16,
                color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
              )
            else
              const SizedBox(width: 4),
            const SizedBox(width: 6),

            // 自定义前置图标
            if (icon != null) ...[
              icon!,
              const SizedBox(width: 6),
            ],

            // 文本区域：动词高亮 + 目标对象 + 详情
            Expanded(
              child: Text.rich(
                TextSpan(
                  children: [
                    TextSpan(
                      text: verb,
                      style: TextStyle(
                        color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                        fontWeight: bold ? FontWeight.w600 : FontWeight.w500,
                        fontSize: 13,
                      ),
                    ),
                    if (object.isNotEmpty)
                      TextSpan(
                        text: ' $object',
                        style: TextStyle(
                          color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                          fontSize: 13,
                        ),
                      ),
                    if (detail != null && detail!.isNotEmpty)
                      TextSpan(
                        text: ' $detail',
                        style: TextStyle(
                          color: isDark ? BaoColors.darkTextFaint : BaoColors.lightTextFaint,
                          fontSize: 12,
                        ),
                      ),
                  ],
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),

            if (trailing != null) ...[
              const SizedBox(width: 8),
              trailing!,
            ],
          ],
        ),
      ),
    );
  }
}

/// BaoCode 风格终端与代码输出视窗 (StepOutputCard)
class StepOutputCard extends StatelessWidget {
  const StepOutputCard({
    super.key,
    required this.output,
    this.title,
    this.maxHeight = 240,
  });

  final String output;
  final String? title;
  final double maxHeight;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final bg = isDark ? BaoColors.darkCodeBg : BaoColors.lightCodeBg;
    final border = isDark ? BaoColors.darkBorder : BaoColors.lightBorder;

    return Container(
      margin: const EdgeInsets.only(top: 4, bottom: 8),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: border, width: 0.8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 顶部小栏 (标题 + 复制按钮)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: border, width: 0.6)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  title ?? 'Output',
                  style: TextStyle(
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: isDark ? BaoColors.darkTextFaint : BaoColors.lightTextFaint,
                  ),
                ),
                InkWell(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: output));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('已复制到剪贴板'),
                        duration: Duration(milliseconds: 1500),
                        behavior: SnackBarBehavior.floating,
                      ),
                    );
                  },
                  child: Padding(
                    padding: const EdgeInsets.all(4),
                    child: Icon(
                      Icons.copy_rounded,
                      size: 13,
                      color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                    ),
                  ),
                ),
              ],
            ),
          ),
          // 内容区域
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxHeight),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(10),
              child: SelectableText(
                output,
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12,
                  height: 1.45,
                  color: isDark ? BaoColors.darkText : BaoColors.lightText,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// BaoCode 胶囊提示标签 (PillBadge)
class PillBadge extends StatelessWidget {
  const PillBadge({
    super.key,
    required this.label,
    this.icon,
    this.dotColor,
    this.onTap,
  });

  final String label;
  final IconData? icon;
  final Color? dotColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final content = Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: isDark ? BaoColors.darkSurface : BaoColors.lightSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
          width: 0.8,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dotColor != null) ...[
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: dotColor,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 5),
          ],
          if (icon != null) ...[
            Icon(
              icon,
              size: 13,
              color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
            ),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w500,
              color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
            ),
          ),
          if (onTap != null) ...[
            const SizedBox(width: 2),
            Icon(
              Icons.keyboard_arrow_down_rounded,
              size: 13,
              color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
            ),
          ],
        ],
      ),
    );

    if (onTap != null) {
      return InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: content,
      );
    }
    return content;
  }
}

/// 错误或提示横幅 (ErrorNotice)
class ErrorNotice extends StatelessWidget {
  const ErrorNotice(this.message, {super.key, this.onDismiss});
  final String? message;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    if (message == null || message!.isEmpty) return const SizedBox.shrink();
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF2D1818) : const Color(0xFFFDE8E8),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(
          color: isDark ? const Color(0xFF592424) : const Color(0xFFF8B4B4),
          width: 0.8,
        ),
      ),
      child: Row(
        children: [
          Icon(
            Icons.error_outline_rounded,
            size: 16,
            color: isDark ? BaoColors.red : const Color(0xFFE02424),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: SelectableText(
              message!,
              style: TextStyle(
                fontSize: 12.5,
                color: isDark ? const Color(0xFFF8B4B4) : const Color(0xFF9B1C1C),
              ),
            ),
          ),
          if (onDismiss != null)
            GestureDetector(
              onTap: onDismiss,
              child: Padding(
                padding: const EdgeInsets.only(left: 6),
                child: Icon(
                  Icons.close_rounded,
                  size: 15,
                  color: isDark ? BaoColors.red : const Color(0xFFE02424),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// VS Code 风格的文本输入框
Widget input(
  String label,
  TextEditingController controller, {
  bool secret = false,
  TextInputType? keyboard,
  int? maxLength,
  bool enabled = true,
  String? hint,
}) => Padding(
  padding: const EdgeInsets.symmetric(vertical: 6),
  child: TextField(
    controller: controller,
    obscureText: secret,
    enabled: enabled,
    keyboardType: keyboard,
    decoration: InputDecoration(
      labelText: label,
      hintText: hint,
      counterText: '',
    ),
    onChanged: maxLength == null
        ? null
        : (value) {
            if (value.length > maxLength) {
              controller.value = TextEditingValue(
                text: value.substring(0, maxLength),
                selection: TextSelection.collapsed(offset: maxLength),
              );
            }
          },
  ),
);
