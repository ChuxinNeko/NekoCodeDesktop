import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../mobile_controller.dart';

export 'welcome_backdrop.dart' show WelcomeBackdrop;

/// 首页欢迎内容：品牌、问候、项目 / 代理选择与快捷建议。
class WelcomeView extends StatelessWidget {
  const WelcomeView({
    super.key,
    required this.controller,
    required this.onPickProject,
    required this.onPickAgent,
    required this.onSuggestion,
  });

  final MobileController controller;
  final VoidCallback onPickProject, onPickAgent;
  final ValueChanged<String> onSuggestion;

  static const suggestions = [
    ('梳理项目结构', '帮我梳理这个项目的目录结构和核心模块'),
    ('修复最近的报错', '运行测试，找出失败原因并修复'),
    ('补充单元测试', '为最近改动的代码补充单元测试'),
    ('审查未提交改动', '审查当前未提交的改动，指出潜在问题'),
  ];

  String get greeting {
    final h = DateTime.now().hour;
    if (h < 5) return '夜深了，还在忙？';
    if (h < 11) return '早上好，今天做点什么？';
    if (h < 14) return '中午好，接下来做点什么？';
    if (h < 18) return '下午好，我们做点什么？';
    return '晚上好，我们做点什么？';
  }

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final mx = context.mx;
    final project = c.project;
    final projectLabel = project == null
        ? (c.projects.isEmpty ? '未授权项目' : '选择项目')
        : string(project['name'], '项目');
    final agent = c.isAcp
        ? string(
            c.enabledAgents
                .where((a) => a['id'] == c.workspace)
                .firstOrNull?['name'],
            c.workspace,
          )
        : 'NekoCode';

    return LayoutBuilder(
      builder: (context, box) => SingleChildScrollView(
        physics: const BouncingScrollPhysics(),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: box.maxHeight),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (!c.online) ...[
                  _Notice(text: '电脑未连接，保持电脑唤醒并运行 NekoCode 后会自动重连。'),
                  const SizedBox(height: 28),
                ],
                _Logo(),
                const SizedBox(height: 22),
                MiuixText(
                  greeting,
                  fontSize: 24,
                  fontWeight: NekoWeight.title,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                MiuixText(
                  '描述任务，NekoCode 会在电脑上读写代码、运行命令并汇报结果',
                  fontSize: 14,
                  height: 1.5,
                  textAlign: TextAlign.center,
                  color: mx.onSurfaceVariantSummary,
                ),
                const SizedBox(height: 20),
                Wrap(
                  alignment: WrapAlignment.center,
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    _ContextPill(
                      icon: MiuixIcons.os4.folder,
                      label: projectLabel,
                      onTap: c.projects.isEmpty ? null : onPickProject,
                    ),
                    if (c.enabledAgents.isNotEmpty)
                      _ContextPill(
                        icon: MiuixIcons.os4.rocket,
                        label: agent,
                        onTap: onPickAgent,
                      ),
                  ],
                ),
                if (c.online && c.projects.isEmpty) ...[
                  const SizedBox(height: 14),
                  MiuixText(
                    '请先在电脑「设置 → 手机连接」中添加允许新建任务的项目',
                    fontSize: 12.5,
                    textAlign: TextAlign.center,
                    color: mx.onSurfaceVariantSummary,
                  ),
                ],
                const SizedBox(height: 32),
                Wrap(
                  alignment: WrapAlignment.center,
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final (label, prompt) in suggestions)
                      _Suggestion(
                        label: label,
                        onTap: () => onSuggestion(prompt),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Logo extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final mx = context.mx;
    return Container(
      width: 84,
      height: 84,
      decoration: ShapeDecoration(
        color: mx.surfaceContainer,
        shape: NekoShape.squircle(28),
      ),
      padding: const EdgeInsets.all(12),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(18),
        child: Image.asset('assets/images/logo.png', fit: BoxFit.contain),
      ),
    );
  }
}

/// 玻璃质感的上下文胶囊（项目 / 代理），点击弹出选择器。
class _ContextPill extends StatelessWidget {
  const _ContextPill({required this.icon, required this.label, this.onTap});
  final MiuixVectorIcon icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final mx = context.mx;
    final body = DecoratedBox(
      decoration: ShapeDecoration(
        color: mx.surfaceContainer.withValues(alpha: .78),
        shape: StadiumBorder(
          side: BorderSide(color: mx.dividerLine.withValues(alpha: .6)),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 10, 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            MiuixIcon(vector: icon, size: 15, tint: mx.onSurfaceVariantSummary),
            const SizedBox(width: 6),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 180),
              child: MiuixText(
                label,
                fontSize: 13.5,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (onTap != null) ...[
              const SizedBox(width: 2),
              RotatedBox(
                quarterTurns: 1,
                child: MiuixIcon(
                  vector: MiuixIcons.os4.chevronForward,
                  size: 13,
                  tint: mx.onSurfaceVariantActions,
                ),
              ),
            ],
          ],
        ),
      ),
    );
    return onTap == null
        ? body
        : MiuixPressable(
            onPressed: onTap,
            feedbackType: MiuixPressFeedbackType.sink,
            semanticLabel: label,
            child: body,
          );
  }
}

class _Suggestion extends StatelessWidget {
  const _Suggestion({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final mx = context.mx;
    return MiuixPressable(
      onPressed: onTap,
      feedbackType: MiuixPressFeedbackType.sink,
      semanticLabel: label,
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: mx.surfaceContainerHigh.withValues(alpha: .7),
          shape: NekoShape.squircle(14),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: MiuixText(label, fontSize: 13.5, color: mx.onSurfaceSecondary),
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) {
    final tone = NekoTone.warning(context.isDark);
    return DecoratedBox(
      decoration: ShapeDecoration(
        color: tone.withValues(alpha: .12),
        shape: NekoShape.squircle(16),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            MiuixIcon(vector: MiuixIcons.os4.info, size: 18, tint: tone),
            const SizedBox(width: 10),
            Expanded(
              child: MiuixText(text, fontSize: 13.5, height: 1.4, color: tone),
            ),
          ],
        ),
      ),
    );
  }
}
