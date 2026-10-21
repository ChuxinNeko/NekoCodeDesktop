import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../ui/theme.dart';

/// Local home illustration and static halftone. No network, timers or input.
class WelcomeBackdrop extends StatelessWidget {
  const WelcomeBackdrop({super.key});
  static const asset = 'assets/images/home-sakura.webp';
  @override
  Widget build(BuildContext context) {
    final surface = context.mx.surface, dark = context.isDark;
    return IgnorePointer(
      child: ExcludeSemantics(
        child: RepaintBoundary(
          child: ClipRect(
            child: Stack(
              fit: StackFit.expand,
              children: [
                ColoredBox(color: surface),
                Image.asset(
                  asset,
                  fit: BoxFit.cover,
                  alignment: Alignment.topCenter,
                  excludeFromSemantics: true,
                  filterQuality: FilterQuality.medium,
                  color: dark ? const Color(0xff555565) : null,
                  colorBlendMode: dark ? BlendMode.modulate : null,
                  errorBuilder: (_, _, _) => ColoredBox(color: surface),
                ),
                DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      stops: const [0, .22, .44, .64, .82, 1],
                      colors: [
                        surface.withValues(alpha: dark ? .16 : .04),
                        surface.withValues(alpha: dark ? .22 : .12),
                        surface.withValues(alpha: dark ? .68 : .62),
                        surface.withValues(alpha: .94),
                        surface,
                        surface,
                      ],
                    ),
                  ),
                ),
                CustomPaint(
                  key: const ValueKey('home-halftone'),
                  painter: WelcomeDotPainter(dark: dark),
                  isComplex: true,
                  willChange: false,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Deterministic printed screen texture; the composer area stays clear.
class WelcomeDotPainter extends CustomPainter {
  const WelcomeDotPainter({required this.dark});
  final bool dark;
  static double densityAt(double y) {
    if (y < 0 || y >= .7) return 0;
    final intro = (y / .14).clamp(0.0, 1.0),
        fade = ((.7 - y) / .36).clamp(0.0, 1.0);
    return intro * fade * fade;
  }

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    const gap = 4.0;
    final paint = Paint(),
        color = dark ? const Color(0xffd1d4ed) : const Color(0xff334665);
    for (var row = 0; row * gap < size.height * .7; row++) {
      final y = row * gap + gap / 2,
          fade = densityAt((row * gap + gap / 2) / size.height);
      if (fade <= 0) continue;
      for (var col = 0; col * gap < size.width; col++) {
        final x = col * gap + (row.isOdd ? gap / 2 : 0),
            wave =
                (math.sin(
                      (col * gap + (row.isOdd ? gap / 2 : 0)) * .021 + y * .013,
                    ) +
                    1) /
                2;
        paint.color = color.withValues(
          alpha: (dark ? .19 : .30) * fade * (.65 + wave * .35),
        );
        canvas.drawCircle(Offset(x, y), .38 + wave * .34, paint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant WelcomeDotPainter oldDelegate) =>
      dark != oldDelegate.dark;
}
