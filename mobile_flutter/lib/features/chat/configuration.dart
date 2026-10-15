import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';

/// 输入框上方的一排配置胶囊：权限 / 模式 / 模型 / 思考 / Fusion。
class ConfigurationBar extends StatelessWidget {
  const ConfigurationBar({super.key, required this.controller});
  final MobileController controller;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final value = c.snapshot ?? c.defaults ?? {};

    Widget chip(
      String title,
      String field,
      List<Json> choices, {
      bool enabled = true,
    }) {
      final current = choices
          .where((o) => o['value'] == value[field])
          .firstOrNull;
      final label = string(
        current?['short'],
        string(current?['name'], '${value[field] ?? '—'}'),
      );
      return PillBadge(
        label: '$title · $label',
        onTap: !enabled || c.busy || !c.online || choices.isEmpty
            ? null
            : () async {
                final picked = await showNekoPicker<String>(
                  context,
                  title: title,
                  selected: value[field] as String?,
                  choices: [
                    for (final o in choices)
                      NekoChoice(
                        string(o['value']),
                        string(o['name']),
                        group: field == 'modelKey'
                            ? string(o['provider'])
                            : null,
                      ),
                  ],
                );
                if (picked != null) await c.configure({field: picked});
              },
      );
    }

    final chips = <Widget>[];
    if (c.isAcp) {
      for (final option in records(value['configOptions'])) {
        final choices = records(option['options']);
        final current = choices
            .where((o) => o['value'] == option['currentValue'])
            .firstOrNull;
        chips.add(
          PillBadge(
            label:
                '${option['name']} · ${current?['name'] ?? option['currentValue']}',
            onTap: value['status'] == 'ready' && !c.busy
                ? () async {
                    final picked = await showNekoPicker<String>(
                      context,
                      title: string(option['name']),
                      selected: option['currentValue'] as String?,
                      choices: [
                        for (final o in choices)
                          NekoChoice(string(o['value']), string(o['name'])),
                      ],
                    );
                    if (picked != null) {
                      await c.configure({
                        'configId': option['id'],
                        'value': picked,
                      });
                    }
                  }
                : null,
          ),
        );
      }
    } else {
      chips.addAll([
        chip('权限', 'mode', [
          {'value': 'read-only', 'name': '只读'},
          {'value': 'auto', 'name': '自动审批'},
          {'value': 'full-access', 'name': '完全访问'},
        ]),
        chip('模式', 'workMode', [
          for (final mode in ['agent', 'ask', 'plan', 'debug', 'multitask'])
            {'value': mode, 'name': mode},
        ]),
        chip('模型', 'modelKey', [
          for (final model in records(value['models']))
            {
              'value': model['key'],
              'provider': model['providerName'] ?? model['provider'],
              'name': '${model['name'] ?? model['id']}',
            },
        ]),
        if (value['fusion'] == null)
          chip('思考', 'thinkingLevel', [
            for (final level in value['thinkingLevels'] as List? ?? ['off'])
              {'value': level, 'name': level},
          ]),
        PillBadge(
          label: value['fusion'] == null
              ? 'Fusion / Team'
              : 'Fusion · ${object(value['fusion'])['strategy'] ?? 'delegate'}',
          selected: value['fusion'] != null,
          onTap: c.busy || !c.online
              ? null
              : () => showNekoSheet<void>(
                  context,
                  title: 'Fusion / Team',
                  subtitle: '多模型协作策略',
                  maxHeightFactor: .85,
                  builder: (_) => FusionSheet(controller: c),
                ),
        ),
      ]);
    }

    return SizedBox(
      height: 44,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
        itemCount: chips.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (_, i) => Center(child: chips[i]),
      ),
    );
  }
}

/// Fusion / Team 配置面板内容（显示在底部面板中）。
class FusionSheet extends StatefulWidget {
  const FusionSheet({super.key, required this.controller});
  final MobileController controller;
  @override
  State<FusionSheet> createState() => _FusionSheetState();
}

class _FusionSheetState extends State<FusionSheet> {
  late Json config;
  late List<Json> models;

  @override
  void initState() {
    super.initState();
    final value =
        widget.controller.snapshot ?? widget.controller.defaults ?? {};
    models = records(value['models']);
    final model = value['modelKey'] ?? models.firstOrNull?['key'];
    config = {
      ...(value['fusion'] is Map
          ? object(value['fusion'])
          : {
              'orchestration': 'engine',
              'strategy': 'delegate',
              'leadModelKey': model,
              'sidekickModelKey': model,
              'leadThinkingLevel': value['thinkingLevel'] ?? 'off',
              'sidekickThinkingLevel': value['thinkingLevel'] ?? 'off',
            }),
    };
  }

  List levelsFor(dynamic modelKey) =>
      models.where((m) => m['key'] == modelKey).firstOrNull?['thinkingLevels']
          as List? ??
      ['off'];

  Widget select(String title, String field, List<Json> items) {
    final current = items.where((i) => i['value'] == config[field]).firstOrNull;
    return MiuixArrowPreference(
      title: title,
      endActions: [
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 170),
          child: MiuixText(
            string(current?['name'], '未选择'),
            fontSize: 14.5,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            color: context.mx.onSurfaceVariantSummary,
          ),
        ),
      ],
      onClick: () async {
        final picked = await showNekoPicker<String>(
          context,
          title: title,
          selected: config[field] as String?,
          choices: [
            for (final i in items)
              NekoChoice(string(i['value']), string(i['name'])),
          ],
        );
        if (picked == null) return;
        setState(() {
          config[field] = picked;
          if (field.endsWith('ModelKey')) {
            final role = field.replaceFirst('ModelKey', '');
            final levels = levelsFor(picked);
            if (!levels.contains(config['${role}ThinkingLevel'])) {
              config['${role}ThinkingLevel'] = levels.first;
            }
          }
        });
      },
    );
  }

  void apply() {
    for (final role in ['lead', 'sidekick']) {
      final levels = levelsFor(config['${role}ModelKey']);
      if (!levels.contains(config['${role}ThinkingLevel'])) {
        config['${role}ThinkingLevel'] = levels.first;
      }
    }
    widget.controller.configure({'fusion': config});
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final mx = context.mx;
    return ListView(
      shrinkWrap: true,
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 20),
      children: [
        MiuixCard(
          cornerRadius: 22,
          colors: MiuixCardColors(
            color: mx.surface,
            contentColor: mx.onSurface,
          ),
          child: Column(
            children: [
              select('策略', 'strategy', [
                for (final v in ['delegate', 'parallel', 'team'])
                  {'value': v, 'name': v},
              ]),
              MiuixSwitchPreference(
                title: '自适应路由',
                value: config['adaptiveRouting'] == true,
                onChanged: (v) => setState(() => config['adaptiveRouting'] = v),
              ),
              if (config['strategy'] == 'team')
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
                  child: MiuixText(
                    '使用电脑「设置 → Team」中的团队成员与权限。手机端与旧版一样不编辑电脑团队配置。',
                    fontSize: 13,
                    height: 1.45,
                    color: mx.onSurfaceVariantSummary,
                  ),
                ),
            ],
          ),
        ),
        for (final role in ['lead', 'sidekick']) ...[
          MiuixSmallTitle(
            role == 'lead' ? 'Lead' : 'Sidekick',
            insideMargin: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          ),
          MiuixCard(
            cornerRadius: 22,
            colors: MiuixCardColors(
              color: mx.surface,
              contentColor: mx.onSurface,
            ),
            child: Column(
              children: [
                select('$role 模型', '${role}ModelKey', [
                  for (final m in models)
                    {'value': m['key'], 'name': m['name'] ?? m['id']},
                ]),
                select('$role 思考', '${role}ThinkingLevel', [
                  for (final v in levelsFor(config['${role}ModelKey']))
                    {'value': v, 'name': v},
                ]),
              ],
            ),
          ),
        ],
        const SizedBox(height: 20),
        Row(
          children: [
            Expanded(
              child: ActionButton(
                '取消',
                onPressed: () => Navigator.pop(context),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: ActionButton(
                '关闭 Fusion',
                danger: true,
                onPressed: () {
                  widget.controller.configure({'fusion': null});
                  Navigator.pop(context);
                },
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        ActionButton(
          '应用',
          isPrimary: true,
          expand: true,
          onPressed: models.isEmpty ? null : apply,
        ),
      ],
    );
  }
}
