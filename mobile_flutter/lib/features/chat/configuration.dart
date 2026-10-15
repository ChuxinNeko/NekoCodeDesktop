import 'package:flutter/material.dart';

import '../../core/protocol.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';

class ConfigurationBar extends StatelessWidget {
  const ConfigurationBar({super.key, required this.controller});
  final MobileController controller;
  @override
  Widget build(BuildContext context) {
    final c = controller;
    final value = c.snapshot ?? c.defaults ?? {};
    Widget picker(
      String title,
      String field,
      List<Json> choices,
    ) {
      final isDark = Theme.of(context).brightness == Brightness.dark;
      return PopupMenuButton<String>(
        enabled: !c.busy && c.online && choices.isNotEmpty,
        tooltip: title,
        onSelected: (v) => c.configure({field: v}),
        itemBuilder: (_) => [
          for (final option in choices) ...[
            if (field == 'modelKey' &&
                choices.indexOf(option) ==
                    choices.indexWhere(
                      (o) => o['provider'] == option['provider'],
                    ))
              PopupMenuItem<String>(
                enabled: false,
                child: Text(
                  string(option['provider']),
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 11),
                ),
              ),
            PopupMenuItem(
              value: string(option['value']),
              child: Text(string(option['name'])),
            ),
          ],
        ],
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 3, vertical: 4),
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
          decoration: BoxDecoration(
            color: isDark ? const Color(0xFF222222) : const Color(0xFFEFEFEF),
            borderRadius: BorderRadius.circular(4),
            border: Border.all(
              color: isDark ? const Color(0xFF333333) : const Color(0xFFDDDDDD),
              width: 0.8,
            ),
          ),
          child: Text(
            '$title: ${choices.where((o) => o['value'] == value[field]).firstOrNull?['name'] ?? value[field] ?? '—'} ▾',
            style: TextStyle(
              fontSize: 11.5,
              color: isDark ? const Color(0xFFCCCCCC) : const Color(0xFF333333),
            ),
          ),
        ),
      );
    };
    if (c.isAcp) {
      return SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (final option in records(value['configOptions']))
              PopupMenuButton<String>(
                enabled: value['status'] == 'ready' && !c.busy,
                tooltip: string(option['name']),
                onSelected: (v) =>
                    c.configure({'configId': option['id'], 'value': v}),
                itemBuilder: (_) => [
                  for (final choice in records(option['options']))
                    PopupMenuItem(
                      value: string(choice['value']),
                      child: Text(string(choice['name'])),
                    ),
                ],
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Text('${option['name']}: ${option['currentValue']} ▾'),
                ),
              ),
          ],
        ),
      );
    }
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          picker('权限', 'mode', [
            {'value': 'read-only', 'name': '只读'},
            {'value': 'auto', 'name': '自动审批'},
            {'value': 'full-access', 'name': '完全访问'},
          ]),
          picker('模式', 'workMode', [
            for (final mode in ['agent', 'ask', 'plan', 'debug', 'multitask'])
              {'value': mode, 'name': mode},
          ]),
          if (value['workMode'] == 'agent')
            Text(
              '· ${value['agentPhase'] ?? 'execute'}',
              style: const TextStyle(fontSize: 12),
            ),
          picker('模型', 'modelKey', [
            for (final model in records(value['models']))
              {
                'value': model['key'],
                'provider': model['providerName'] ?? model['provider'],
                'name':
                    '${model['providerName'] ?? model['provider']}/${model['name'] ?? model['id']}',
              },
          ]),
          if (value['fusion'] == null)
            picker('思考', 'thinkingLevel', [
              for (final level in value['thinkingLevels'] as List? ?? ['off'])
                {'value': level, 'name': level},
            ]),
          TextButton(
            onPressed: c.busy || !c.online
                ? null
                : () => showDialog<void>(
                    context: context,
                    builder: (_) => FusionDialog(controller: c),
                  ),
            child: Text(
              value['fusion'] == null
                  ? 'Fusion / Team'
                  : 'Fusion · ${object(value['fusion'])['strategy'] ?? 'delegate'}',
            ),
          ),
        ],
      ),
    );
  }
}

class FusionDialog extends StatefulWidget {
  const FusionDialog({super.key, required this.controller});
  final MobileController controller;
  @override
  State<FusionDialog> createState() => _FusionDialogState();
}

class _FusionDialogState extends State<FusionDialog> {
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

  Widget select(String title, String field, List<Json> items) =>
      DropdownButtonFormField<String>(
        key: ValueKey('$field:${config[field]}'),
        initialValue: items.any((i) => i['value'] == config[field])
            ? config[field] as String?
            : null,
        decoration: InputDecoration(labelText: title),
        items: [
          for (final i in items)
            DropdownMenuItem(
              value: string(i['value']),
              child: Text(string(i['name']), overflow: TextOverflow.ellipsis),
            ),
        ],
        onChanged: (v) => setState(() {
          config[field] = v;
          if (field.endsWith('ModelKey')) {
            final role = field.replaceFirst('ModelKey', '');
            final levels =
                models
                        .where((m) => m['key'] == v)
                        .firstOrNull?['thinkingLevels']
                    as List? ??
                ['off'];
            if (!levels.contains(config['${role}ThinkingLevel'])) {
              config['${role}ThinkingLevel'] = levels.first;
            }
          }
        }),
        isExpanded: true,
      );
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Fusion / Team'),
    content: SizedBox(
      width: 360,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            select('策略', 'strategy', [
              for (final v in ['delegate', 'parallel', 'team'])
                {'value': v, 'name': v},
            ]),
            SwitchListTile(
              title: const Text('自适应路由'),
              value: config['adaptiveRouting'] == true,
              onChanged: (v) => setState(() => config['adaptiveRouting'] = v),
            ),
            if (config['strategy'] == 'team')
              const Padding(
                padding: EdgeInsets.all(8),
                child: Text('使用电脑「设置 → Team」中的团队成员与权限。手机端与旧版一样不编辑电脑团队配置。'),
              ),
            for (final role in ['lead', 'sidekick']) ...[
              select('$role 模型', '${role}ModelKey', [
                for (final m in models)
                  {'value': m['key'], 'name': m['name'] ?? m['id']},
              ]),
              select('$role 思考', '${role}ThinkingLevel', [
                for (final v
                    in (models
                                .where(
                                  (m) => m['key'] == config['${role}ModelKey'],
                                )
                                .firstOrNull?['thinkingLevels']
                            as List? ??
                        ['off']))
                  {'value': v, 'name': v},
              ]),
            ],
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      TextButton(
        onPressed: () {
          widget.controller.configure({'fusion': null});
          Navigator.pop(context);
        },
        child: const Text('关闭 Fusion'),
      ),
      ActionButton(
        '应用',
        onPressed: models.isEmpty
            ? null
            : () {
                for (final role in ['lead', 'sidekick']) {
                  final levels =
                      models
                              .where(
                                (m) => m['key'] == config['${role}ModelKey'],
                              )
                              .firstOrNull?['thinkingLevels']
                          as List? ??
                      ['off'];
                  if (!levels.contains(config['${role}ThinkingLevel'])) {
                    config['${role}ThinkingLevel'] = levels.first;
                  }
                }
                widget.controller.configure({'fusion': config});
                Navigator.pop(context);
              },
      ),
    ],
  );
}
