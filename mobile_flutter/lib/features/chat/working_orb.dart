// Port of thinking-orbs 0.3.1's solving/rubik renderer, 20px preset.
// Copyright (c) 2026 Jakub Antalik. MIT; see THIRD_PARTY_NOTICES.md.
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../ui/theme.dart';

class WorkingOrb extends StatefulWidget {
  const WorkingOrb({super.key});
  @override
  State<WorkingOrb> createState() => _WorkingOrbState();
}

class _WorkingOrbState extends State<WorkingOrb>
    with SingleTickerProviderStateMixin {
  late final animation = AnimationController(
    vsync: this,
    duration: const Duration(days: 1),
  );
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      animation.stop();
    } else if (!animation.isAnimating) {
      animation.repeat();
    }
  }

  @override
  void dispose() {
    animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dark = context.isDark;
    if (MediaQuery.disableAnimationsOf(context)) {
      return Container(
        width: 12,
        height: 12,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: (dark ? Colors.white : const Color(0xff1a1c1f)).withValues(
            alpha: .4,
          ),
        ),
      );
    }
    return AnimatedBuilder(
      animation: animation,
      builder: (_, _) => CustomPaint(
        size: const Size.square(20),
        painter: _RubikPainter(animation.value * 86400 * 1.95, dark),
      ),
    );
  }
}

double _hash(double x, double y) {
  final t = math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return t - t.floorToDouble();
}

class _RubikPainter extends CustomPainter {
  _RubikPainter(this.time, this.dark);
  final double time;
  final bool dark;
  @override
  void paint(Canvas canvas, Size size) {
    // resolvePreset('solving', 20): 15/40 density scaled by sqrt(.088).
    const latRings = 4, lonDensity = 12, moveCount = 14;
    const step = .42;
    final position = time % (2 * moveCount * step + 1.2);
    final amounts = List<double>.filled(moveCount, 0);
    var active = -1;
    if (position < 2 * moveCount * step) {
      final phase = (position / step).floor();
      final fraction = (position - phase * step) / step;
      final progress =
          1 - math.pow(1 - math.min(1, fraction / .7), 3).toDouble();
      if (phase < moveCount) {
        for (var j = 0; j < phase; j++) {
          amounts[j] = 1;
        }
        amounts[phase] = progress;
        active = phase;
      } else {
        final j = 2 * moveCount - 1 - phase;
        for (var k = 0; k < j; k++) {
          amounts[k] = 1;
        }
        amounts[j] = 1 - progress;
        active = j;
      }
    }
    final yaw = time * .55, pitch = .35 + .1 * math.sin(time * .9);
    final dots = <({Offset point, double z, double radius, int ink})>[];
    final scale = math.pow(size.width / 300, .6);
    for (var ring = 0; ring <= latRings; ring++) {
      final latitude = -math.pi / 2 + ring / latRings * math.pi;
      final cosLat = math.cos(latitude), sinLat = math.sin(latitude);
      final count = math.max(1, (cosLat.abs() * lonDensity).round());
      for (var dot = 0; dot < count; dot++) {
        final longitude = dot / count * 2 * math.pi;
        var x = cosLat * math.cos(longitude),
            y = sinLat,
            z = cosLat * math.sin(longitude);
        var moving = false;
        for (var j = 0; j < moveCount; j++) {
          if (amounts[j] <= 0) continue;
          final axis = math.min(2, (_hash(j.toDouble(), 2.3) * 3).floor());
          final lo =
              -1 + .5 * math.min(3, (_hash(j.toDouble(), 5.9) * 4).floor());
          final coordinate = axis == 0
              ? x
              : axis == 1
              ? y
              : z;
          if (coordinate < lo || coordinate >= lo + .5) continue;
          if (j == active) moving = true;
          final angle =
              (_hash(j.toDouble(), 7.7) < .5 ? 1 : -1) *
              math.pi /
              2 *
              amounts[j];
          final c = math.cos(angle), s = math.sin(angle);
          if (axis == 0) {
            final next = y * c - z * s;
            z = y * s + z * c;
            y = next;
          } else if (axis == 1) {
            final next = x * c + z * s;
            z = -x * s + z * c;
            x = next;
          } else {
            final next = x * c - y * s;
            y = x * s + y * c;
            x = next;
          }
        }
        final rx = x * math.cos(yaw) + z * math.sin(yaw);
        final rz = -x * math.sin(yaw) + z * math.cos(yaw);
        final ry = y * math.cos(pitch) - rz * math.sin(pitch);
        final depth = y * math.sin(pitch) + rz * math.cos(pitch);
        final v = (depth + 1) / 2;
        final white = (.62 - .54 * v - (moving ? .14 : 0)).clamp(0.0, 1.0);
        dots.add((
          point: Offset(
            size.width / 2 + rx * size.width / 2 * .82,
            size.height / 2 - ry * size.height / 2 * .82,
          ),
          z: depth,
          radius: math.max(.3, (1.14 + 3.23 * v + (moving ? .57 : 0)) * scale),
          ink: ((dark ? 1 - white : white) * 255).round(),
        ));
      }
    }
    dots.sort((a, b) => a.z.compareTo(b.z));
    final paint = Paint();
    for (final dot in dots) {
      paint.color = Color.fromARGB(255, dot.ink, dot.ink, dot.ink);
      canvas.drawCircle(dot.point, dot.radius, paint);
    }
  }

  @override
  bool shouldRepaint(_RubikPainter oldDelegate) =>
      oldDelegate.time != time || oldDelegate.dark != dark;
}
