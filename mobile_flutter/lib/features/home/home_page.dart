import 'package:flutter/material.dart';

import '../../ui/theme.dart';
import '../../ui/widgets.dart';

/// Bootstrap screen.
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Scaffold(
      appBar: AppBar(
        title: const PillBadge(label: 'NekoCode'),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
          children: [
            const SizedBox(height: 32),
            Center(
              child: Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  color: isDark ? BaoColors.darkSurface : BaoColors.lightSurface,
                  border: Border.all(
                    color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
                    width: 0.8,
                  ),
                ),
                child: const Icon(
                  Icons.terminal_rounded,
                  size: 32,
                  color: BaoColors.accent,
                ),
              ),
            ),
            const SizedBox(height: 20),
            Text(
              'NekoCode Mobile',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
            ),
            const SizedBox(height: 10),
            Text(
              'BaoCode 沉浸式架构驱动的移动端 Agent 客户端。\n与桌面版 NekoCode 协同工作，随时掌控推理与任务。',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                height: 1.5,
                fontSize: 13,
              ),
            ),
            const SizedBox(height: 32),
            ActionButton(
              '关于 NekoCode',
              isPrimary: true,
              onPressed: () => showAboutDialog(
                context: context,
                applicationName: 'NekoCode Mobile',
                applicationLegalese: 'BaoCode & VS Code 沉浸式风格移动客户端',
                children: const [Text('支持公网加密通信与局域网无缝协作。')],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
