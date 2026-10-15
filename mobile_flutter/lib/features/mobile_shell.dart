import 'dart:async';

import 'package:flutter/material.dart';

import '../core/protocol.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'chat/chat_page.dart';
import 'connection/account_view.dart';
import 'connection/pairing_view.dart';
import 'home/home_page.dart';
import 'mobile_controller.dart';

class MobileShell extends StatefulWidget {
  const MobileShell({
    super.key,
    required this.controller,
    required this.toggleTheme,
    required this.dark,
    this.initialize = true,
  });

  final MobileController controller;
  final VoidCallback toggleTheme;
  final bool dark, initialize;

  @override
  State<MobileShell> createState() => _MobileShellState();
}

class _MobileShellState extends State<MobileShell> with WidgetsBindingObserver {
  MobileController get c => widget.controller;
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  int _navIndex = 0; // 0: 对话, 1: 任务, 2: 扩展/智能体, 3: 设置/我的

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (widget.initialize) unawaited(c.initialize());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    c.foreground = state == AppLifecycleState.resumed;
    if (c.foreground) unawaited(c.refresh());
  }

  Future<void> pickProject() async {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final project = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: isDark ? BaoColors.darkSurface : BaoColors.lightSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(12)),
        side: BorderSide(color: BaoColors.darkBorder, width: 0.8),
      ),
      builder: (context) => SafeArea(
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * .65,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  margin: const EdgeInsets.symmetric(vertical: 8),
                  width: 32,
                  height: 3,
                  decoration: BoxDecoration(
                    color: isDark ? BaoColors.darkBorderSubtle : BaoColors.lightBorderSubtle,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '选择工作区项目',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '在此项目创建独立运行的 Agent 任务',
                      style: TextStyle(
                        color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                        fontSize: 12.5,
                      ),
                    ),
                  ],
                ),
              ),
              const Divider(),
              Expanded(
                child: c.projects.isEmpty
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            '请先在电脑「设置 → 手机连接」中添加允许新建任务的项目。',
                            style: TextStyle(
                              fontSize: 13,
                              color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                            ),
                          ),
                        ),
                      )
                    : ListView.separated(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        itemCount: c.projects.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 6),
                        itemBuilder: (_, i) {
                          final p = c.projects[i];
                          return Material(
                            color: isDark ? BaoColors.darkSidebarBg : BaoColors.lightSidebarBg,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(6),
                              side: BorderSide(
                                color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
                                width: 0.8,
                              ),
                            ),
                            child: ListTile(
                              dense: true,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                              leading: Container(
                                padding: const EdgeInsets.all(6),
                                decoration: BoxDecoration(
                                  color: BaoColors.accent.withValues(alpha: 0.12),
                                  borderRadius: BorderRadius.circular(6),
                                ),
                                child: const Icon(Icons.folder_outlined, size: 18, color: BaoColors.accent),
                              ),
                              title: Text(
                                string(p['name']),
                                style: TextStyle(
                                  fontWeight: FontWeight.w600,
                                  fontSize: 13.5,
                                  color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                                ),
                              ),
                              subtitle: Text(
                                string(p['path']),
                                style: TextStyle(
                                  fontSize: 11.5,
                                  color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                                ),
                              ),
                              onTap: () => Navigator.pop(context, p['id'] as String),
                            ),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
    if (project != null) await c.newTask(project: project);
  }

  Future<void> create() async {
    if (c.projects.length != 1) {
      await pickProject();
    } else {
      await c.newTask(project: c.projects.first['id'] as String);
    }
  }

  /// BaoCode 风格侧边栏 (Drawer)
  Widget _buildDrawer(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final rows = c.allTasks;
    final groups = <String, List<Json>>{};
    for (final row in rows) {
      groups.putIfAbsent(string(row['cwd']), () => []).add(row);
    }

    return Drawer(
      backgroundColor: isDark ? BaoColors.darkSidebarBg : BaoColors.lightSidebarBg,
      child: SafeArea(
        child: Column(
          children: [
            // 顶部「新会话」按钮 (VS Code / BaoCode 质感)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 6),
              child: InkWell(
                onTap: () {
                  Navigator.pop(context);
                  create();
                },
                borderRadius: BorderRadius.circular(6),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: isDark ? const Color(0xFF262626) : const Color(0xFFE8E8E8),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(
                      color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
                      width: 0.8,
                    ),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.add_rounded, size: 16, color: BaoColors.accent),
                      const SizedBox(width: 6),
                      Text(
                        '新建 Agent 会话',
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 13,
                          color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const Divider(indent: 14, endIndent: 14),

            // 会话历史与项目分组
            Expanded(
              child: rows.isEmpty
                  ? Center(
                      child: Text(
                        c.online ? '暂无历史任务' : '等待电脑连接…',
                        style: TextStyle(
                          color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                          fontSize: 12.5,
                        ),
                      ),
                    )
                  : ListView(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      children: [
                        for (final group in groups.entries) ...[
                          Padding(
                            padding: const EdgeInsets.fromLTRB(8, 10, 8, 4),
                            child: Row(
                              children: [
                                Icon(
                                  Icons.folder_open_rounded,
                                  size: 13,
                                  color: isDark ? BaoColors.darkTextFaint : BaoColors.lightTextFaint,
                                ),
                                const SizedBox(width: 6),
                                Expanded(
                                  child: Text(
                                    (group.key.split(RegExp(r'[/\\]')).where((s) => s.isNotEmpty).lastOrNull ?? group.key).toUpperCase(),
                                    style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: FontWeight.bold,
                                      letterSpacing: 0.5,
                                      color: isDark ? BaoColors.darkTextFaint : BaoColors.lightTextFaint,
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          for (final task in group.value)
                            _buildTaskTile(context, task, isDark),
                        ],
                      ],
                    ),
            ),
            const Divider(indent: 14, endIndent: 14),

            // 侧栏底栏设备状态与设置
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              child: Row(
                children: [
                  Container(
                    width: 28,
                    height: 28,
                    decoration: BoxDecoration(
                      color: isDark ? BaoColors.darkSurface : BaoColors.lightSurface,
                      borderRadius: BorderRadius.circular(4),
                      border: Border.all(
                        color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
                        width: 0.8,
                      ),
                    ),
                    child: Center(
                      child: Text(
                        c.desktop.name.isNotEmpty ? c.desktop.name.substring(0, 1).toUpperCase() : 'N',
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          fontSize: 12,
                          color: BaoColors.accent,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          c.desktop.name.isNotEmpty ? c.desktop.name : '未命名设备',
                          style: TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 12.5,
                            color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Row(
                          children: [
                            Container(
                              width: 6,
                              height: 6,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: c.online ? BaoColors.green : BaoColors.amber,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              c.online ? 'Online' : 'Offline',
                              style: TextStyle(
                                fontSize: 10.5,
                                color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: Icon(
                      widget.dark ? Icons.light_mode_outlined : Icons.dark_mode_outlined,
                      size: 18,
                    ),
                    tooltip: '切换外观',
                    onPressed: widget.toggleTheme,
                  ),
                  IconButton(
                    icon: const Icon(Icons.settings_outlined, size: 18),
                    tooltip: '手机设置',
                    onPressed: () {
                      Navigator.pop(context);
                      setState(() => _navIndex = 3);
                      c.navigate('settings');
                    },
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTaskTile(BuildContext context, Json task, bool isDark) {
    final isSelected = c.view == 'chat' && (c.taskId == task['id'] || c.acpId == task['id']);
    final isRunning = task['running'] == true;
    final title = task['titlePending'] == true ? '新会话' : string(task['title'], '新会话');

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 1),
      child: Material(
        color: isSelected
            ? (isDark ? const Color(0xFF262626) : const Color(0xFFE5E5E5))
            : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(4),
          side: isSelected
              ? const BorderSide(color: BaoColors.accent, width: 1.2)
              : BorderSide.none,
        ),
        child: ListTile(
          dense: true,
          contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 0),
          leading: Icon(
            isRunning ? Icons.timelapse_rounded : Icons.chat_bubble_outline_rounded,
            size: 14,
            color: isRunning
                ? BaoColors.accent
                : (isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary),
          ),
          title: Text(
            title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 12.5,
              fontWeight: isSelected ? FontWeight.w600 : FontWeight.normal,
              color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
            ),
          ),
          onTap: () {
            Navigator.pop(context);
            setState(() => _navIndex = 0);
            if (task['_acp'] == true) {
              unawaited(c.openAcp(task));
            } else {
              unawaited(c.openTask(task));
            }
          },
        ),
      ),
    );
  }

  Widget tasksList() {
    final rows = c.allTasks;
    final groups = <String, List<Json>>{};
    for (final row in rows) {
      groups.putIfAbsent(string(row['cwd']), () => []).add(row);
    }
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return RefreshIndicator(
      onRefresh: () async {
        c.histories.clear();
        await c.refresh();
      },
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                '定时任务与历史',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.bold,
                  color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: isDark ? BaoColors.darkSurface : BaoColors.lightSurface,
                  borderRadius: BorderRadius.circular(4),
                  border: Border.all(
                    color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
                    width: 0.8,
                  ),
                ),
                child: Text(
                  '${rows.where((s) => s['running'] == true).length} 运行中',
                  style: TextStyle(
                    fontSize: 11,
                    color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (c.acpError != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text(
                '外部代理暂不可用：${c.acpError}。普通任务仍可使用。',
                style: const TextStyle(fontSize: 12, color: BaoColors.amber),
              ),
            ),
          if (rows.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 60),
              child: Center(
                child: Text(
                  c.online ? '暂无任务，点击右上角 ＋ 创建' : '等待电脑连接…',
                  style: TextStyle(
                    color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                    fontSize: 13,
                  ),
                ),
              ),
            ),
          for (final group in groups.entries) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(2, 14, 2, 6),
              child: Row(
                children: [
                  const Icon(Icons.folder_outlined, size: 14, color: BaoColors.accent),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      group.key.split(RegExp(r'[/\\]')).where((s) => s.isNotEmpty).lastOrNull ?? group.key,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                        color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            for (final task in group.value)
              Container(
                margin: const EdgeInsets.only(bottom: 6),
                child: Material(
                  color: isDark ? BaoColors.darkSurface : BaoColors.lightSurface,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(6),
                    side: BorderSide(
                      color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
                      width: 0.8,
                    ),
                  ),
                  child: ListTile(
                    dense: true,
                    enabled: !c.busy && c.online,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                    leading: Icon(
                      task['running'] == true ? Icons.timelapse_rounded : Icons.chat_bubble_outline_rounded,
                      color: task['running'] == true ? BaoColors.accent : (isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary),
                      size: 16,
                    ),
                    title: Text(
                      task['titlePending'] == true ? '新会话' : string(task['title'], '新会话'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 13.5,
                        color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                      ),
                    ),
                    subtitle: Text(
                      [
                        if (task['_acp'] == true) string(task['agentName'], string(task['agentId'])),
                        if (string(task['preview']).isNotEmpty) string(task['preview']),
                        _date(task['updatedAt']),
                      ].join(' · '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11.5,
                        color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                      ),
                    ),
                    onTap: () {
                      setState(() => _navIndex = 0);
                      if (task['_acp'] == true) {
                        unawaited(c.openAcp(task));
                      } else {
                        unawaited(c.openTask(task));
                      }
                    },
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }

  String _date(dynamic value) => value is num
      ? DateTime.fromMillisecondsSinceEpoch(value.toInt())
            .toLocal()
            .toString()
            .split('.')
            .first
      : '';

  Widget settings() => ListView(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
    children: [
      Text(
        '已连接电脑（${c.desktop.mode == 'relay' ? '公网连接' : '局域网'}）',
        style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
      ),
      const SizedBox(height: 8),
      Text(c.desktop.name, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
      SelectableText(c.desktop.endpoint, style: const TextStyle(fontSize: 12, color: Colors.grey)),
      const SizedBox(height: 10),
      if (c.desktop.mode != 'relay' && c.desktop.relay.binding != null)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: ActionButton(
            '切换到公网连接',
            onPressed: c.busy ? null : () => c.switchTransport('relay'),
          ),
        ),
      if (c.desktop.mode != 'lan' && c.desktop.lan != null)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: ActionButton(
            '切换到局域网',
            onPressed: c.busy ? null : () => c.switchTransport('lan'),
          ),
        ),
      const SizedBox(height: 20),
      const Divider(),
      const SizedBox(height: 14),
      Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          const Text('外观模式', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
          ActionButton(
            widget.dark ? '深色' : '浅色',
            icon: widget.dark ? Icons.dark_mode_outlined : Icons.light_mode_outlined,
            onPressed: widget.toggleTheme,
          ),
        ],
      ),
      const SizedBox(height: 20),
      const Divider(),
      const SizedBox(height: 14),
      const Text('并行任务说明', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
      const SizedBox(height: 6),
      const Text(
        '手机与桌面共享任务列表。新任务独立运行，切换会话不会停止后台任务。同一项目中的任务共享文件，请避免同时修改相同文件。',
        style: TextStyle(fontSize: 12.5, color: Colors.grey, height: 1.4),
      ),
      const SizedBox(height: 14),
      Text(
        '电脑需保持唤醒并运行 NekoCode。${c.desktop.mode == 'relay' ? '公网消息端到端加密；设备公钥由服务器分发，请只在可信服务上使用。' : '局域网 HTTP 连接仅适用于可信网络。'}',
        style: const TextStyle(fontSize: 12.5, color: Colors.grey, height: 1.4),
      ),
      const SizedBox(height: 20),
      const Divider(),
      const SizedBox(height: 14),
      const Text('公网连接管理', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
      const SizedBox(height: 10),
      PublicConnectionView(controller: c),
      const SizedBox(height: 20),
      ActionButton('断开并移除当前连接', onPressed: c.busy ? null : c.disconnect),
    ],
  );

  /// 顶栏标题区：BaoCode 风格胶囊指示与项目切换
  Widget _buildAppBarTitle(bool isDark) {
    final title = c.snapshot?['title'] ?? (c.taskId != null ? '当前任务' : 'NekoCode');
    final projectName = string(
      object(c.snapshot?['session'])['cwd'],
      string(c.snapshot?['cwd'], string(c.project?['name'], c.project?['path'] ?? '未选择项目')),
    );
    final shortProject = projectName.split(RegExp(r'[/\\]')).where((s) => s.isNotEmpty).lastOrNull ?? projectName;
    final deviceName = c.desktop.name.isNotEmpty ? c.desktop.name : '电脑连接';

    return InkWell(
      onTap: pickProject,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 160),
                  child: Text(
                    string(title),
                    style: TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w600,
                      color: isDark ? BaoColors.darkTextPrimary : BaoColors.lightTextPrimary,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 2),
                Icon(
                  Icons.keyboard_arrow_down_rounded,
                  size: 14,
                  color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                ),
              ],
            ),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.terminal_rounded,
                  size: 11,
                  color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                ),
                const SizedBox(width: 3),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 160),
                  child: Text(
                    '$deviceName · $shortProject',
                    style: TextStyle(
                      fontSize: 10.5,
                      fontFamily: 'monospace',
                      color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 3),
                Icon(
                  c.desktop.mode == 'relay' ? Icons.lock_outline_rounded : Icons.wifi_rounded,
                  size: 10,
                  color: isDark ? BaoColors.darkTextSecondary : BaoColors.lightTextSecondary,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return ListenableBuilder(
      listenable: c,
      builder: (context, _) => PopScope(
        canPop: c.view == 'tasks' || !c.paired,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) {
            setState(() => _navIndex = 1);
            c.navigate('tasks');
          }
        },
        child: Scaffold(
          key: _scaffoldKey,
          drawer: c.paired ? _buildDrawer(context) : null,
          appBar: c.paired
              ? AppBar(
                  leading: IconButton(
                    icon: const Icon(Icons.menu_rounded, size: 20),
                    tooltip: '侧边菜单',
                    onPressed: () => _scaffoldKey.currentState?.openDrawer(),
                  ),
                  centerTitle: true,
                  title: _buildAppBarTitle(isDark),
                  actions: [
                    IconButton(
                      tooltip: '新建会话',
                      icon: const Icon(Icons.add_rounded, size: 20),
                      onPressed: c.busy || !c.online ? null : create,
                    ),
                    IconButton(
                      tooltip: '工作台',
                      icon: const Icon(Icons.more_horiz_rounded, size: 20),
                      onPressed: () => _scaffoldKey.currentState?.openDrawer(),
                    ),
                  ],
                )
              : null,
          body: SafeArea(
            top: !c.paired,
            child: !c.ready
                ? const Center(
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation<Color>(BaoColors.accent),
                    ),
                  )
                : !c.paired
                ? PairingView(controller: c)
                : Column(
                    children: [
                      if (c.view != 'chat')
                        ErrorNotice(
                          c.error,
                          onDismiss: () {
                            c.error = null;
                            c.emit();
                          },
                        ),
                      Expanded(
                        child: _navIndex == 0
                            ? (c.view == 'chat'
                                ? ChatPage(
                                    key: ValueKey('chat:${c.chatVersion}'),
                                    controller: c,
                                    onPickProject: pickProject,
                                  )
                                : tasksList())
                            : _navIndex == 1
                            ? tasksList()
                            : _navIndex == 2
                            ? const HomePage()
                            : settings(),
                      ),
                    ],
                  ),
          ),
          bottomNavigationBar: c.paired
              ? Container(
                  decoration: BoxDecoration(
                    color: isDark ? BaoColors.darkSidebarBg : BaoColors.lightSidebarBg,
                    border: Border(
                      top: BorderSide(
                        color: isDark ? BaoColors.darkBorder : BaoColors.lightBorder,
                        width: 0.8,
                      ),
                    ),
                  ),
                  child: BottomNavigationBar(
                    currentIndex: _navIndex,
                    selectedItemColor: BaoColors.accent,
                    unselectedItemColor: isDark ? BaoColors.darkTextSecondary : Colors.grey,
                    selectedFontSize: 11,
                    unselectedFontSize: 11,
                    onTap: (index) {
                      setState(() => _navIndex = index);
                      if (index == 0) {
                        c.navigate(c.taskId != null ? 'chat' : 'tasks');
                      } else if (index == 1) {
                        c.navigate('tasks');
                      } else if (index == 3) {
                        c.navigate('settings');
                      }
                    },
                    items: const [
                      BottomNavigationBarItem(
                        icon: Icon(Icons.chat_bubble_outline_rounded, size: 20),
                        activeIcon: Icon(Icons.chat_bubble_rounded, size: 20),
                        label: '对话',
                      ),
                      BottomNavigationBarItem(
                        icon: Icon(Icons.timer_outlined, size: 20),
                        activeIcon: Icon(Icons.timer_rounded, size: 20),
                        label: '任务',
                      ),
                      BottomNavigationBarItem(
                        icon: Icon(Icons.extension_outlined, size: 20),
                        activeIcon: Icon(Icons.extension_rounded, size: 20),
                        label: '扩展',
                      ),
                      BottomNavigationBarItem(
                        icon: Icon(Icons.settings_outlined, size: 20),
                        activeIcon: Icon(Icons.settings_rounded, size: 20),
                        label: '设置',
                      ),
                    ],
                  ),
                )
              : null,
        ),
      ),
    );
  }
}
