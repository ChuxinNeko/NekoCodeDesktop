import '../../core/protocol.dart';
import 'transcript_rows.dart';

/// Desktop workStages.ts, projected locally from the unchanged wire transcript.
/// Positional IDs survive the live assistant cell being persisted under a new ID.
class WorkStage {
  WorkStage(
    this.id,
    this.title,
    this.category,
    this.items, {
    this.titleSource,
    this.phase,
    this.topic,
  });
  final String id;
  String title, category;
  String? titleSource, phase, topic;
  final List<TranscriptRow> items;
}

String workCategory(TranscriptRow item) {
  if (item.kind != 'tool') {
    return item.kind == 'message' ? 'task' : item.kind;
  }
  final name = string(item.cell?['toolName']);
  if (name.startsWith('computer_')) return 'computer';
  if (['read', 'read_file', 'readFile', 'stat', 'ls'].contains(name)) {
    return 'read';
  }
  if (['edit', 'write', 'writeFile', 'apply_patch'].contains(name)) {
    return 'edit';
  }
  if ([
    'bash',
    'powershell',
    'cmd',
    'ssh',
    'exec_command',
    'shell',
    'terminal',
  ].contains(name)) {
    return 'command';
  }
  if (RegExp('search|grep|find|browse|fetch').hasMatch(name)) return 'search';
  if (['task', 'subagent'].contains(name)) return 'task';
  return 'tools';
}

List<({int line, String text})> _headings(String text) {
  final headings = <({int line, String text})>[];
  String? marker;
  var length = 0;
  final lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    final raw = lines[i], value = raw.trim();
    final fence = RegExp(r'^(`{3,}|~{3,})(.*)$').firstMatch(value);
    if (fence != null) {
      if (marker == null) {
        marker = fence[1]![0];
        length = fence[1]!.length;
      } else if (fence[1]![0] == marker &&
          fence[1]!.length >= length &&
          fence[2]!.trim().isEmpty) {
        marker = null;
      }
      continue;
    }
    if (marker != null || RegExp(r'^(?: {4}|\t)').hasMatch(raw)) continue;
    final match = RegExp(
      r'^(?:#{1,6}\s+(.+?)(?:\s+#+)?|\*\*(.+?)\*\*)$',
    ).firstMatch(value);
    if (match != null) headings.add((line: i, text: match[1] ?? match[2]!));
  }
  return headings;
}

String _conciseTitle(String text, String language) {
  final title = text
      .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]*\)'), (m) => m[1]!)
      .replaceAll(RegExp(r'\*|__|`'), '')
      .trim();
  if (title.isEmpty ||
      RegExp(r'[\r\n。！？；;!?，,]|\.(?=\s|$)|[:：]$').hasMatch(title)) {
    return '';
  }
  if (title.length > (language == 'zh-CN' ? 32 : 72) ||
      title.split(RegExp(r'\s+')).length > 8) {
    return '';
  }
  if (RegExp(r'^(?:我(?:们)?|接下来|随后|然后|现在|正在|先来|让我们)').hasMatch(title)) return '';
  if (RegExp(
    r"^(?:(?:I|We|Let(?:['’]s| me)|Need to|Now|Next|Then)\b)",
    caseSensitive: false,
  ).hasMatch(title)) {
    return '';
  }
  if (RegExp(
    r'^(?:Evaluating|Assessing|Clarifying|Considering|Reasoning|Thinking|Planning)(?:\b|[:：])',
    caseSensitive: false,
  ).hasMatch(title)) {
    return '';
  }
  if (RegExp(
    r'^(?:思考与规划|处理任务|执行命令|使用工具|分析细节|评估实现细节|评估令牌预算)$',
  ).hasMatch(title)) {
    return '';
  }
  if (RegExp(
    r'^(?:thinking|analysis|report(?:ing)?|done|finish(?:ed)?|final(?: answer)?|follow the skill|planning next step|next step|hmm|思考|分析|下一步|遵循技能|整理结果)$',
    caseSensitive: false,
  ).hasMatch(title)) {
    return '';
  }
  final chinese = RegExp(r'[\u3400-\u9fff]').hasMatch(title);
  if (language == 'zh-CN' ? !chinese : chinese) return '';
  return title;
}

String workStageTitle(String text, {String language = 'zh-CN'}) {
  for (final heading in _headings(text)) {
    final title = _conciseTitle(heading.text, language);
    if (title.isNotEmpty) return title;
  }
  return '';
}

Json _args(TranscriptRow item) =>
    object(item.cell?['args'] ?? item.cell?['input']);
String _toolDescription(TranscriptRow item, String language) {
  final description = string(_args(item)['description']);
  if (!RegExp(
    r'^(?:读取|检查|查看|运行|执行|验证|修改|实现|整理|定位|搜索|测试|确认|确定|梳理|追踪|分析|保留|移植|接入|清理|补充|构建|编译|打开|安装|修复|对比|更新|创建|删除|连接|调整|Read(?:ing)?\b|Check(?:ing)?\b|Inspect(?:ing)?\b|Search(?:ing)?\b|Run(?:ning)?\b|Test(?:ing)?\b|Verify(?:ing)?\b|Fix(?:ing)?\b|Build(?:ing)?\b|Update?\b|Edit(?:ing)?\b)',
    caseSensitive: false,
  ).hasMatch(description)) {
    return '';
  }
  return _conciseTitle(description, language);
}

bool _fileTitle(String title) => RegExp(
  r'^(?:读取|查看|检查|搜索|编辑|修改|Read|Inspect|Search|Edit)\s*[\w@.~/\\:+-]+\.[a-z0-9]{1,10}$',
  caseSensitive: false,
).hasMatch(title);

const _phaseLabels = {
  'investigate': '检查实现与相关调用',
  'implement': '实现代码改动与行为',
  'verify': '检查类型与测试结果',
  'build': '编译界面并检查构建结果',
  'install': '安装组件与项目依赖',
  'preview': '检查界面布局与实际交互',
  'computer': '检查桌面界面与操作结果',
  'task': '组织任务并检查执行进展',
  'command': '检查命令执行结果',
  'tools': '检查工具执行结果',
  'thinking': '梳理实现方案与约束',
  'notice': '查看执行状态与提示',
};
const _inspectLabels = {
  'entry': '检查项目入口与启动配置',
  'ui': '检查界面组件与调用关系',
  'theme': '检查主题变量与布局常量',
  'tests': '检查测试范围与断言',
  'source': '确认组件来源与接入约定',
  'results': '读取构建结果与验证记录',
};
const _editLabels = {
  'entry': '调整项目入口与启动配置',
  'ui': '修改界面组件与交互',
  'theme': '调整主题与布局样式',
  'tests': '补充测试与回归断言',
  'source': '接入上游组件与依赖',
};
String workStageLabel(WorkStage stage) {
  if (stage.title.isNotEmpty && !_fileTitle(stage.title)) return stage.title;
  final phase =
      stage.phase ??
      switch (stage.category) {
        'read' || 'search' => 'investigate',
        'edit' => 'implement',
        _ => stage.category,
      };
  final topicLabel = phase == 'investigate'
      ? _inspectLabels[stage.topic]
      : phase == 'implement'
      ? _editLabels[stage.topic]
      : null;
  return topicLabel ?? _phaseLabels[phase] ?? _phaseLabels['tools']!;
}

bool _hasDetails(TranscriptRow item) {
  if (item.kind == 'tool') return true;
  return string(
    item.cell?[item.kind == 'thinking' ? 'thinking' : 'text'],
  ).replaceAll(RegExp(r'[#*_`\s]'), '').isNotEmpty;
}

bool workStageHasDetails(WorkStage stage) => stage.items.any(_hasDetails);

List<TranscriptRow> _proseParts(TranscriptRow item) {
  final field = item.kind == 'thinking' ? 'thinking' : 'text';
  final text = string(item.cell?[field]);
  final boundaries = _headings(text).map((h) => h.line).toSet();
  final parts = <String>[];
  var current = <String>[];
  final lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (boundaries.contains(i) &&
        current.any((line) => line.trim().isNotEmpty)) {
      parts.add(current.join('\n'));
      current = [];
    }
    current.add(lines[i]);
  }
  parts.add(current.join('\n'));
  if (parts.length == 1) return [item];
  return [
    for (var i = 0; i < parts.length; i++)
      TranscriptRow(
        item.kind,
        '${item.id}-part-$i',
        cell: {...item.cell!, field: parts[i]},
      ),
  ];
}

({String? phase, String topic}) _toolActivity(TranscriptRow item, bool edited) {
  final args = _args(item);
  final description = string(args['description']);
  final command = string(args['command'], string(args['cmd']));
  final path = string(
    args['path'],
    string(args['file_path'], string(args['filePath'])),
  );
  final metadata = '$description $path $command';
  bool matches(String pattern) =>
      RegExp(pattern, caseSensitive: false).hasMatch(metadata);
  final topic =
      matches(
        r'构建结果|构建日志|验证记录|(?:build|typecheck|test)[^\s]*\.log|/tmp/[^\s]*\.log',
      )
      ? 'results'
      : matches(
          r'主题|样式|变量|布局常量|theme|foundation\.css|index\.css|\.css\b|tailwind',
        )
      ? 'theme'
      : matches(r'上游|组件来源|源码追溯|原始组件|接入约定|upstream|registry|beautifului\.dev')
      ? 'source'
      : matches(r'测试|断言|(?:^|[ /])tests?/|\.(?:test|spec)\.')
      ? 'tests'
      : matches(
          r'组件|侧栏|消息|输入|界面|交互|sidebar|transcript|composer|markdown|components[/\\]',
        )
      ? 'ui'
      : matches(
          r'入口|启动|配置|package\.json|(?:vite|tsconfig)|(?:server|index|main|app)\.[cm]?[jt]sx?',
        )
      ? 'entry'
      : 'general';
  final name = string(item.cell?['toolName']);
  final category = workCategory(item);
  final localPage =
      name == 'browser_navigate' &&
      RegExp(
        r'^(?:https?://(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)|file://)',
        caseSensitive: false,
      ).hasMatch(string(args['url']));
  if (edited &&
      (localPage ||
          [
            'browser_viewport',
            'browser_evaluate',
            'browser_screenshot',
            'browser_action',
          ].contains(name))) {
    return (phase: 'preview', topic: 'ui');
  }
  if (category == 'command') {
    bool executable(String pattern) => RegExp(
      '(?:^|[;&|]\\s*)(?:[A-Z_][A-Z_0-9]*=(?:"[^"]*"|\'[^\']*\'|[^\\s]+)\\s+)*(?:$pattern)(?=\\s|\$)',
      caseSensitive: false,
    ).hasMatch(command.trim());
    bool starts(String pattern) => RegExp(pattern).hasMatch(description);
    if (executable(
          r'(?:bun|npm|pnpm|yarn|npx)\s+(?:run\s+)?(?:test|typecheck|lint|vitest|tsc)|pytest|vitest|playwright|tsc|flutter\s+(?:test|analyze)|dart\s+(?:test|analyze)',
        ) ||
        starts(r'^(?:测试|验证|复测|运行.*测试|检查.*(?:类型|兼容))')) {
      return (phase: 'verify', topic: topic);
    }
    if (executable(
          r'(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build|vite\s+build|electron-vite\s+build|flutter\s+build',
        ) ||
        starts(r'^(?:编译|构建)')) {
      return (phase: 'build', topic: topic);
    }
    if (executable(
          r'(?:bun|npm|pnpm|yarn)\s+(?:install|add)|(?:bunx|npx)\s+(?:--yes\s+|-y\s+)?shadcn(?:@[^\s]+)?|(?:flutter|dart)\s+pub\s+(?:get|add)',
        ) ||
        starts(r'^(?:安装)')) {
      return (phase: 'install', topic: topic);
    }
    if (starts(r'^(?:修改|实现|移植|保留|接入|清理|修复|更新|创建|删除|调整|补充)')) {
      return (phase: 'implement', topic: topic);
    }
    if (executable(
          r'cat|sed|head|tail|ls|stat|rg|grep|find|git\s+(?:status|diff|show)|curl|wget',
        ) ||
        starts(r'^(?:读取|查看|检查|检索|搜索|定位|确认|确定)')) {
      return (phase: 'investigate', topic: topic);
    }
    return (phase: null, topic: topic);
  }
  return (
    phase: switch (category) {
      'read' || 'search' => 'investigate',
      'edit' => 'implement',
      'tools' => null,
      _ => category,
    },
    topic: topic,
  );
}

List<WorkStage> groupWorkStages(
  List<TranscriptRow> items, {
  String language = 'zh-CN',
}) {
  final stages = <WorkStage>[];
  var pending = <TranscriptRow>[];
  var pendingId = '', edited = false;
  void appendPending(WorkStage stage) {
    stage.items.addAll(pending);
    pending = [];
    pendingId = '';
  }

  for (var index = 0; index < items.length; index++) {
    final original = items[index];
    if (!_hasDetails(original)) continue;
    final parts = ['thinking', 'message'].contains(original.kind)
        ? _proseParts(original)
        : [original];
    for (var part = 0; part < parts.length; part++) {
      final item = parts[part];
      if (!_hasDetails(item)) continue;
      var previous = stages.lastOrNull;
      final prose = ['thinking', 'message'].contains(item.kind);
      final text = string(
        item.cell?[item.kind == 'thinking' ? 'thinking' : 'text'],
      );
      final candidate = prose
          ? workStageTitle(text, language: language)
          : _toolDescription(item, language);
      final title = _fileTitle(candidate) ? '' : candidate;
      if (prose) {
        if (title.isEmpty) {
          if (pending.isEmpty) pendingId = 'stage-$index-$part';
          pending.add(item);
          continue;
        }
        final sameResponse =
            part == 0 &&
            item.kind == 'message' &&
            previous != null &&
            previous.items.any(
              (entry) =>
                  entry.kind == 'thinking' &&
                  entry.cell?['id'] == item.cell?['id'],
            );
        if (previous != null &&
            (previous.title == title ||
                (sameResponse &&
                    !previous.items.any((e) => e.kind == 'tool')))) {
          appendPending(previous);
          previous.items.add(item);
          previous.title = title;
          previous.titleSource = 'heading';
          if (item.kind == 'message') previous.category = 'task';
        } else {
          stages.add(
            WorkStage('stage-$index-$part', title, workCategory(item), [
              ...pending,
              item,
            ], titleSource: 'heading'),
          );
          pending = [];
          pendingId = '';
        }
        continue;
      }
      if (item.kind == 'notice') {
        if (previous != null) {
          appendPending(previous);
          previous.items.add(item);
        } else {
          if (pending.isEmpty) pendingId = 'stage-$index-$part';
          pending.add(item);
        }
        continue;
      }
      if (item.kind != 'tool') continue;
      final activity = _toolActivity(item, edited);
      final previousHasTool =
          previous?.items.any((e) => e.kind == 'tool') ?? false;
      final plan =
          previous?.titleSource == 'heading' &&
          RegExp(
            r'设计|规划|方案|页面结构|\b(?:design|plan|architecture)\b',
            caseSensitive: false,
          ).hasMatch(previous!.title);
      final phaseChanged =
          previousHasTool &&
          activity.phase != null &&
          previous?.phase != null &&
          activity.phase != previous?.phase;
      final planEnded =
          !previousHasTool &&
          plan &&
          [
            'implement',
            'verify',
            'build',
            'preview',
            'install',
          ].contains(activity.phase);
      final topicChanged =
          previousHasTool &&
          previous?.titleSource != 'heading' &&
          activity.phase == previous?.phase &&
          activity.topic != 'general' &&
          previous?.topic != 'general' &&
          activity.topic != previous?.topic;
      final phase =
          activity.phase ??
          (workCategory(item) == 'tools' ? 'tools' : 'command');
      if (previous == null || phaseChanged || planEnded || topicChanged) {
        previous = WorkStage(
          pendingId.isEmpty ? 'stage-$index-$part' : pendingId,
          title,
          workCategory(item),
          [],
          titleSource: title.isEmpty ? null : 'tool',
          phase: phase,
          topic: activity.topic,
        );
        stages.add(previous);
      } else {
        previous.phase ??= phase;
        if (previous.topic == null || previous.topic == 'general') {
          previous.topic = activity.topic;
        }
        if (previous.title.isEmpty && title.isNotEmpty) {
          previous.title = title;
          previous.titleSource = 'tool';
        }
      }
      appendPending(previous);
      previous.items.add(item);
      if (activity.phase == 'implement') edited = true;
    }
  }
  if (pending.isNotEmpty) {
    if (stages.isNotEmpty) {
      appendPending(stages.last);
    } else {
      stages.add(
        WorkStage('stage-0-0', '', workCategory(pending.first), pending),
      );
    }
  }
  return stages;
}

bool workStageCompleted(WorkStage? stage) {
  if (stage == null) return false;
  final tools = stage.items.where((i) => i.kind == 'tool');
  if (tools.isEmpty ||
      tools.any((i) => ['pending', 'running'].contains(i.cell?['status']))) {
    return false;
  }
  final lastTool = stage.items.lastIndexWhere((i) => i.kind == 'tool');
  final latest = stage.items
      .skip(lastTool + 1)
      .where((i) => i.kind == 'message')
      .lastOrNull;
  if (latest == null || latest.cell?['streaming'] == true) return false;
  return string(latest.cell?['text'])
      .split(RegExp(r'\r?\n'))
      .any(
        (line) =>
            RegExp(
              r'^(?:本阶段|当前阶段|这一阶段|这一步)(?:的工作|工作|任务)?(?:已全部完成|已经完成|已完成|完成了)[。.!！\s]*$',
            ).hasMatch(line.trim()) ||
            RegExp(
              r'^(?:this|the current) (?:stage|phase|step) (?:is (?:now )?complete|has been completed)[.!\s]*$',
              caseSensitive: false,
            ).hasMatch(line.trim()),
      );
}
