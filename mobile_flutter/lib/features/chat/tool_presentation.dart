import 'package:flutter/material.dart';

import '../../core/protocol.dart';

/// 工具调用的展示信息（标题、对象、图标），与桌面端 ToolCalls 保持一致。
class ToolPresentation {
  const ToolPresentation({
    required this.label,
    required this.subject,
    required this.icon,
    this.meta,
    this.isShell = false,
    this.prompt = '\$',
    this.cwd,
  });

  final String label;
  final String subject;
  final IconData icon;
  final String? meta;
  final bool isShell;
  final String prompt;
  final String? cwd;
}

ToolPresentation presentTool(Json cell) {
  final name = string(cell['name'], string(cell['toolName']));
  final input = cell['input'] ?? cell['args'];

  // 参数提取辅助
  String? argString(String key) {
    if (input is Map &&
        input[key] is String &&
        (input[key] as String).isNotEmpty) {
      return input[key] as String;
    }
    return null;
  }

  int? argNumber(String key) {
    if (input is Map && input[key] is num) return (input[key] as num).toInt();
    return null;
  }

  String pathBasename(String p) =>
      p.split(RegExp(r'[\\/]')).where((s) => s.isNotEmpty).lastOrNull ?? p;

  // 1. Terminal / Shell 命令类工具 (对应 NekoCode Desktop TerminalCard)
  if (name == 'bash' ||
      name == 'powershell' ||
      name == 'cmd' ||
      name == 'terminal') {
    final cmd = argString('command') ?? (input is String ? input : '');
    final cwd = argString('cwd');
    final prompt = name == 'powershell' ? 'PS>' : (name == 'cmd' ? '>' : '\$');
    return ToolPresentation(
      label: '运行命令',
      subject: cmd.split('\n').firstOrNull ?? cmd,
      icon: Icons.terminal_rounded,
      isShell: true,
      prompt: prompt,
      cwd: cwd,
    );
  }

  if (name == 'ssh' && argString('op') == 'exec') {
    final host = argString('host') ?? 'ssh';
    final cmd = argString('command') ?? '';
    return ToolPresentation(
      label: host,
      subject: cmd.split('\n').firstOrNull ?? cmd,
      icon: Icons.dns_rounded,
      isShell: true,
      prompt: '$host \$',
    );
  }

  // 2. 读文件 (read)
  if (name == 'read' || name == 'readFile') {
    final p = argString('path') ?? '';
    final offset = argNumber('offset');
    final limit = argNumber('limit');
    String? meta;
    if (offset != null && limit != null) {
      meta = 'L$offset–${offset + limit - 1}';
    } else if (offset != null) {
      meta = 'L$offset+';
    } else if (limit != null) {
      meta = 'L1–$limit';
    }
    return ToolPresentation(
      label: '读取文件',
      subject: p.isNotEmpty ? pathBasename(p) : '文件',
      icon: Icons.description_outlined,
      meta: meta,
    );
  }

  // 3. 编辑/写入文件 (edit / write)
  if (name == 'edit' || name == 'write' || name == 'writeFile') {
    final p = argString('path') ?? '';
    return ToolPresentation(
      label: name == 'edit' ? '编辑文件' : '写入文件',
      subject: p.isNotEmpty ? pathBasename(p) : '文件',
      icon: Icons.edit_note_rounded,
    );
  }

  // 4. 搜索与定位 (grep / find / semantic_search / code_search / ast_grep)
  if (name == 'grep') {
    return ToolPresentation(
      label: '搜索',
      subject: argString('pattern') ?? '',
      icon: Icons.search_rounded,
    );
  }
  if (name == 'find') {
    return ToolPresentation(
      label: '查找文件',
      subject: argString('pattern') ?? '',
      icon: Icons.manage_search_rounded,
    );
  }
  if (name == 'code_search') {
    return ToolPresentation(
      label: '定位代码',
      subject: argString('query') ?? '',
      icon: Icons.saved_search_rounded,
    );
  }
  if (name == 'semantic_search') {
    return ToolPresentation(
      label: '语义搜索',
      subject: argString('query') ?? '',
      icon: Icons.travel_explore_rounded,
      meta: argString('path'),
    );
  }
  if (name == 'ls') {
    final p = argString('path') ?? '.';
    return ToolPresentation(
      label: '列出目录',
      subject: pathBasename(p),
      icon: Icons.folder_open_rounded,
    );
  }
  if (name == 'stat') {
    return ToolPresentation(
      label: '测量文件',
      subject: argString('path') ?? '',
      icon: Icons.straighten_rounded,
    );
  }
  if (name == 'github') {
    return ToolPresentation(
      label: 'GitHub',
      subject: [
        argString('repo'),
        argString('op'),
      ].where((s) => s != null && s.isNotEmpty).join(' · '),
      icon: Icons.commit_rounded,
    );
  }
  if (name == 'web_search') {
    return ToolPresentation(
      label: '网页搜索',
      subject: argString('query') ?? '',
      icon: Icons.language_rounded,
    );
  }
  if (name == 'web_fetch') {
    final url = argString('url') ?? '';
    return ToolPresentation(
      label: '抓取网页',
      subject: url,
      icon: Icons.public_rounded,
    );
  }

  // 默认普通工具
  return ToolPresentation(
    label: name,
    subject:
        argString('command') ?? argString('path') ?? argString('query') ?? '',
    icon: Icons.build_outlined,
  );
}
