import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/attachments.dart';
import '../core/desktop_client.dart';
import '../core/protocol.dart';

class MobileController extends ChangeNotifier {
  MobileController(this.desktop);
  final DesktopClient desktop;
  bool ready = false,
      online = false,
      busy = false,
      refreshing = false,
      foreground = true,
      loadingEarlier = false;
  bool _disposed = false;
  Timer? _timer;
  String view = 'tasks', workspace = 'nekolocal';
  String? error, projectId, taskId, acpId;
  Json? snapshot, defaults;
  List<Json> projects = [], tasks = [], agents = [], acpSessions = [];
  final Map<String, Json> histories = {};
  int _opening = 0;
  int get chatVersion => _opening;
  bool get paired => desktop.mode != null;
  bool get isAcp => workspace != 'nekolocal';
  Json? get project => projects.where((p) => p['id'] == projectId).firstOrNull;
  List<Json> get enabledAgents =>
      agents.where((a) => a['enabled'] == true).toList();
  void emit() {
    if (!_disposed) notifyListeners();
  }

  void clear() {
    _opening++;
    desktop.forgetSync();
    taskId = null;
    acpId = null;
    snapshot = null;
    defaults = null;
    acpError = null;
    projects = [];
    tasks = [];
    agents = [];
    acpSessions = [];
    histories.clear();
    projectId = null;
    workspace = 'nekolocal';
  }

  Future<void> initialize() async {
    try {
      await desktop.restore();
    } catch (e) {
      error = '$e';
    }
    ready = true;
    emit();
    await refresh();
    if (!_disposed) {
      _timer = Timer.periodic(const Duration(milliseconds: 1500), (_) {
        if (foreground) unawaited(refresh());
      });
    }
  }

  Future<void> action(Future<void> Function() run) async {
    if (busy) return;
    busy = true;
    error = null;
    emit();
    try {
      await run();
    } catch (e) {
      error = '$e';
      await unauthorized(e);
    } finally {
      busy = false;
      emit();
    }
  }

  Future<void> unauthorized(Object cause) async {
    if (cause is! ApiError || cause.status != 401) return;
    online = false;
    if (desktop.mode == 'relay') {
      desktop.relay.close();
      if (desktop.lan != null) {
        await desktop.switchMode('lan');
        clear();
      } else {
        await desktop.deactivate();
        clear();
      }
    } else {
      await desktop.disconnect();
      clear();
    }
    view = 'tasks';
  }

  String? acpError;

  Future<void> refresh() async {
    if (!paired || refreshing || !foreground || _disposed) return;
    refreshing = true;
    final marker = desktop.generation;
    final opening = _opening;
    final selectedTask = taskId, selectedAcp = acpId;
    Object? transcriptError;
    try {
      final values = await Future.wait<dynamic>([
        desktop.state(),
        desktop
            .request('/api/acp/state')
            .then((value) {
              if (marker == desktop.generation) acpError = null;
              return value;
            })
            .catchError((Object e) {
              // ACP is an optional desktop subsystem. A valid authenticated state
              // response must remain usable when this subsystem is absent/not ready.
              if (e is ApiError && e.status == 401) throw e;
              if (marker == desktop.generation) acpError = '$e';
              return {'agents': agents, 'sessions': acpSessions};
            }),
        if (view == 'chat' && selectedTask != null)
          desktop.sync(selectedTask).catchError((Object e) {
            transcriptError = e;
            return <String, dynamic>{};
          }),
        if (view == 'chat' && selectedAcp != null)
          desktop
              .request('/api/acp/sessions/${Uri.encodeComponent(selectedAcp)}')
              .catchError((Object e) {
                transcriptError = e;
                return <String, dynamic>{};
              }),
      ]);
      if (marker != desktop.generation || _disposed) return;
      final state = object(values[0]);
      final acp = object(values[1]);
      projects = records(state['projects']);
      tasks = records(state['tasks']);
      agents = records(acp['agents']);
      acpSessions = records(acp['sessions']);
      final previousProject = projectId;
      if (!projects.any((p) => p['id'] == projectId)) {
        projectId = projects.firstOrNull?['id'] as String?;
      }
      if (values.length > 2 &&
          transcriptError == null &&
          opening == _opening &&
          taskId == selectedTask &&
          acpId == selectedAcp) {
        snapshot = object(values[2]);
      }
      if (taskId != null && !tasks.any((t) => t['id'] == taskId)) {
        taskId = null;
        snapshot = null;
        view = 'tasks';
        desktop.forgetSync();
      }
      if (acpError == null &&
          acpId != null &&
          !acpSessions.any((t) => t['id'] == acpId)) {
        acpId = null;
        snapshot = null;
        view = 'tasks';
      }
      if (transcriptError != null &&
          ((selectedTask != null &&
                  tasks.any((t) => t['id'] == selectedTask)) ||
              (selectedAcp != null &&
                  acpError == null &&
                  acpSessions.any((t) => t['id'] == selectedAcp)))) {
        throw transcriptError!;
      }
      online = true;
      if (taskId == null &&
          !isAcp &&
          projectId != null &&
          (defaults == null || previousProject != projectId)) {
        await loadDefaults();
      }
      for (final agent in enabledAgents) {
        final id = agent['id'] as String;
        if (histories.containsKey(id)) continue;
        histories[id] = {'entries': []};
        unawaited(_history(id, marker));
      }
    } catch (e) {
      if (marker == desktop.generation) {
        online = false;
        error = '$e';
        await unauthorized(e);
      }
    } finally {
      refreshing = false;
      emit();
    }
  }

  Future<void> _history(String id, int marker) async {
    try {
      final history = object(
        await desktop.request(
          '/api/acp/agents/${Uri.encodeComponent(id)}/history',
        ),
      );
      if (marker == desktop.generation) histories[id] = history;
    } catch (e) {
      if (marker == desktop.generation) {
        histories[id] = {'entries': [], 'error': '$e'};
      }
    }
    emit();
  }

  Future<void> loadDefaults() async {
    final id = projectId;
    if (id == null) return;
    final marker = desktop.generation;
    final value = await desktop.defaults(id);
    if (id == projectId && marker == desktop.generation) defaults = value;
  }

  Future<void> pairedLan(String endpoint, String code, String name) =>
      action(() async {
        await desktop.pair(endpoint, code, name);
        clear();
        view = 'tasks';
        await refresh();
      });
  Future<void> selectRelay(Json device) => action(() async {
    await desktop.selectRelay(device);
    clear();
    view = 'tasks';
    await refresh();
  });
  Future<void> switchTransport(String mode) => action(() async {
    await desktop.switchMode(mode);
    clear();
    await refresh();
  });
  Future<void> disconnect() => action(() async {
    await desktop.disconnect();
    clear();
    online = false;
    view = 'tasks';
    await refresh();
  });
  Future<void> logout() => action(() async {
    desktop.relay.close();
    await desktop.account.logout();
    if (desktop.mode == 'relay') {
      if (desktop.lan != null) {
        await desktop.switchMode('lan');
      } else {
        await desktop.deactivate();
      }
      clear();
      view = 'tasks';
      await refresh();
    }
  });

  /// 'tasks' 即首页欢迎页：它本身就是一个「草稿会话」，回到首页时
  /// 丢弃当前打开的会话，直接在输入框里开始新任务。
  void navigate(String next) {
    if (next == 'tasks' && view != 'tasks') _resetDraft();
    view = next;
    if (next == 'tasks') histories.clear();
    emit();
    if (next == 'tasks') unawaited(refresh());
  }

  void _resetDraft() {
    _opening++;
    desktop.forgetSync();
    taskId = null;
    acpId = null;
    snapshot = null;
    error = null;
  }

  /// 首页切换项目：只更新草稿配置，不离开欢迎页。
  Future<void> selectProject(String id) async {
    if (id == projectId) return;
    projectId = id;
    if (isAcp) {
      emit();
      return;
    }
    defaults = null;
    emit();
    await action(loadDefaults);
  }

  /// 首页切换代理：NekoCode（nekolocal）或已启用的外部代理。
  Future<void> selectWorkspace(String id) async {
    if (id == workspace) return;
    workspace = id;
    snapshot = null;
    acpId = null;
    emit();
    if (!isAcp && defaults == null) await action(loadDefaults);
  }

  Future<void> newTask({String? project, String? agent}) async {
    _opening++;
    desktop.forgetSync();
    taskId = null;
    acpId = null;
    snapshot = null;
    defaults = null;
    error = null;
    if (project != null) projectId = project;
    if (agent != null) workspace = agent;
    view = 'chat';
    emit();
    await action(() async {
      if (isAcp) {
        if (projectId == null) return;
        final opening = _opening;
        final value = object(
          await desktop.request('/api/acp/sessions', {
            'agentId': workspace,
            'projectId': projectId,
          }),
        );
        if (opening == _opening) {
          acpId = value['id'] as String;
          snapshot = value;
        }
      } else {
        await loadDefaults();
      }
    });
  }

  Future<void> openTask(Json task) async {
    final opening = ++_opening;
    workspace = 'nekolocal';
    acpId = null;
    taskId = task['id'] as String;
    snapshot = null;
    view = 'chat';
    emit();
    await action(() async {
      final value = await desktop.sync(task['id'] as String);
      if (opening == _opening) snapshot = value;
    });
  }

  List<Json> get allTasks {
    final rows = [...tasks];
    for (final agent in enabledAgents) {
      final id = agent['id'];
      final live = acpSessions
          .where((s) => s['agentId'] == id && s['pristine'] != true)
          .toList();
      for (final session in live) {
        final listed = records(
          histories[id]?['entries'],
        ).where((e) => e['sessionId'] == session['agentSessionId']).firstOrNull;
        rows.add({
          ...session,
          if (listed != null) 'updatedAt': listed['updatedAt'],
          if (listed != null &&
              session['title'] == session['agentName'] &&
              string(listed['title']).isNotEmpty)
            'title': listed['title'],
          'running':
              session['status'] == 'prompting' ||
              session['status'] == 'starting',
          '_acp': true,
        });
      }
      for (final entry in records(histories[id]?['entries'])) {
        if (acpSessions.any(
          (s) =>
              s['agentId'] == id && s['agentSessionId'] == entry['sessionId'],
        )) {
          continue;
        }
        rows.add({
          ...entry,
          'id': '$id:${entry['sessionId']}',
          'agentId': id,
          'agentName': agent['name'],
          '_acp': true,
          '_history': true,
        });
      }
    }
    rows.sort(
      (a, b) => ((b['updatedAt'] as num?) ?? 0).compareTo(
        (a['updatedAt'] as num?) ?? 0,
      ),
    );
    return rows;
  }

  Future<void> openAcp(Json row) async {
    final opening = ++_opening;
    taskId = null;
    acpId = row['_history'] == true ? null : row['id'] as String;
    workspace = row['agentId'] as String;
    snapshot = null;
    view = 'chat';
    emit();
    await action(() async {
      final value = object(
        row['_history'] == true
            ? await desktop.request('/api/acp/open', {
                'agentId': row['agentId'],
                'sessionId': row['sessionId'],
                'cwd': row['cwd'],
                'title': row['title'],
              })
            : await desktop.request(
                '/api/acp/sessions/${Uri.encodeComponent(row['id'] as String)}',
              ),
      );
      if (opening == _opening) {
        acpId = value['id'] as String;
        snapshot = value;
      }
    });
  }

  Future<void> configure(Json options) => action(() async {
    if (options.containsKey('fusion') &&
        options['fusion'] == null &&
        taskId != null) {
      // The existing LAN API disables Fusion by selecting a normal model, not null.
      options = {'modelKey': snapshot?['modelKey']};
    }
    if (isAcp || taskId != null) {
      final id = isAcp ? acpId : taskId;
      if (id == null) return;
      final value = isAcp
          ? await desktop.acpAction(id, 'config', options)
          : await desktop.taskAction(id, 'configure', options);
      if (id == (isAcp ? acpId : taskId)) snapshot = value;
    } else if (defaults != null) {
      defaults = {...defaults!, ...options};
      if (options['fusion'] is Map) {
        final fusion = object(options['fusion']);
        defaults!['modelKey'] = fusion['leadModelKey'];
        defaults!['thinkingLevel'] = fusion['leadThinkingLevel'];
      }
      if (options.containsKey('modelKey')) {
        defaults!['fusion'] = null;
        final model = records(
          defaults!['models'],
        ).where((m) => m['key'] == options['modelKey']).firstOrNull;
        defaults!['thinkingLevels'] = model?['thinkingLevels'] ?? ['off'];
        if (!(defaults!['thinkingLevels'] as List).contains(
          defaults!['thinkingLevel'],
        )) {
          defaults!['thinkingLevel'] =
              (defaults!['thinkingLevels'] as List).first;
        }
      }
    }
  });

  /// 分片上传一个附件到电脑（局域网与公网中继走同一条请求通道），
  /// 返回电脑端的上传编号，发送消息时随 `attachments` 一起提交。
  Future<String> upload(
    PendingAttachment file, {
    void Function(double progress)? onProgress,
  }) async {
    if (file.size > maxAttachmentBytes) {
      throw ApiError('单个附件不能超过 ${maxAttachmentBytes ~/ 1024 ~/ 1024} MB');
    }
    final start = object(
      await desktop.request('/api/uploads', {
        'name': file.name,
        'mimeType': file.mimeType,
        'size': file.size,
      }),
    );
    final id = start['id'] as String;
    final chunk = (start['chunkSize'] as num).toInt();
    final count = (start['chunks'] as num).toInt();
    for (var index = 0; index < count; index++) {
      final end = (index + 1) * chunk;
      final data = base64Encode(
        file.bytes.sublist(index * chunk, end > file.size ? file.size : end),
      );
      for (var attempt = 0; ; attempt++) {
        try {
          await desktop.request(
            '/api/uploads/${Uri.encodeComponent(id)}/chunk',
            {'index': index, 'data': data},
          );
          break;
        } catch (e) {
          // 分片按编号幂等：网络抖动时直接重发同一片。
          if (attempt >= 2 || (e is ApiError && e.status == 404)) rethrow;
          await Future<void>.delayed(
            Duration(milliseconds: 400 * (attempt + 1)),
          );
        }
      }
      onProgress?.call((index + 1) / count);
    }
    return id;
  }

  Future<void> cancelUpload(String id) async {
    try {
      await desktop.request(
        '/api/uploads/${Uri.encodeComponent(id)}/cancel',
        {},
      );
    } catch (_) {
      /* 电脑端会在 30 分钟后自动清理。 */
    }
  }

  Future<bool> send(String text, {List<String> attachments = const []}) async {
    if (busy || !online || (text.trim().isEmpty && attachments.isEmpty)) {
      return false;
    }
    final files = {if (attachments.isNotEmpty) 'attachments': attachments};
    bool accepted = false;
    await action(() async {
      if (isAcp) {
        if (acpId == null ||
            (snapshot?['status'] == 'error' && snapshot?['pristine'] == true)) {
          if (projectId == null) throw ApiError('请先选择电脑授权的项目');
          snapshot = object(
            await desktop.request('/api/acp/sessions', {
              'agentId': workspace,
              'projectId': projectId,
            }),
          );
          acpId = snapshot!['id'] as String;
        }
        final id = acpId!;
        final result = await desktop.submit(
          '/api/acp/sessions/${Uri.encodeComponent(id)}/prompt',
          {'text': text, ...files},
        );
        if (result['accepted'] != true) {
          throw ApiError(string(result['error'], '消息未被接受'));
        }
        // Acceptance is final even if the follow-up read fails: do not offer
        // the same draft for resubmission after the server has already run it.
        accepted = true;
        try {
          snapshot = object(
            await desktop.request(
              '/api/acp/sessions/${Uri.encodeComponent(id)}',
            ),
          );
        } catch (e) {
          error = '$e';
        }
      } else if (taskId != null) {
        final result = await desktop.submit(
          '/api/tasks/${Uri.encodeComponent(taskId!)}/send',
          {'text': text, ...files},
        );
        if (result['accepted'] != true) {
          throw ApiError(string(result['error'], '消息未被接受'));
        }
        if (result['action'] == 'new-session') {
          taskId = null;
          snapshot = null;
          desktop.forgetSync();
          await loadDefaults();
        }
      } else {
        if (defaults == null || projectId == null) {
          throw ApiError('请先选择电脑授权的项目');
        }
        final options = {
          for (final key in [
            'modelKey',
            'fusion',
            'thinkingLevel',
            'mode',
            'workMode',
          ])
            if (defaults![key] != null) key: defaults![key],
        };
        if (options['fusion'] != null) options.remove('modelKey');
        final result = await desktop.submit('/api/tasks', {
          'projectId': projectId,
          'text': text,
          'options': options,
          ...files,
        });
        taskId = result['id'] as String;
        if (result['accepted'] != true) {
          throw ApiError(string(result['error'], '任务已创建，但未能开始执行'));
        }
        accepted = true;
        try {
          snapshot = await desktop.sync(taskId!);
        } catch (e) {
          error = '$e';
        }
      }
      accepted = true;
      // 从首页发出的第一条消息创建了会话：进入聊天视图继续跟随输出。
      if (view == 'tasks' && (taskId != null || acpId != null)) view = 'chat';
      unawaited(refresh());
    });
    return accepted;
  }

  Future<void> abort() => action(() async {
    final id = isAcp ? acpId : taskId;
    if (id == null) return;
    snapshot = isAcp
        ? await desktop.acpAction(id, 'cancel', {})
        : await desktop.taskAction(id, 'abort', {});
  });
  Future<void> earlier() async {
    final id = taskId;
    if (id == null || loadingEarlier) return;
    loadingEarlier = true;
    emit();
    try {
      final value = await desktop.sync(id, back: 60);
      if (id == taskId) snapshot = value;
    } catch (e) {
      error = '$e';
    } finally {
      loadingEarlier = false;
      emit();
    }
  }

  /// Keep extension failures on the dialog so its text survives a retry.
  Future<void> answerExtension(Json answer) async {
    final id = taskId;
    if (id == null) throw ApiError('会话已关闭');
    final opening = _opening;
    final marker = desktop.generation;
    final next = await desktop.taskAction(id, 'extension-answer', answer);
    if (opening == _opening && marker == desktop.generation && taskId == id) {
      snapshot = next;
      emit();
    }
  }

  Future<void> answer(Json answer) => action(() async {
    if (taskId != null) {
      snapshot = await desktop.taskAction(taskId!, 'answer', answer);
    }
  });
  Future<void> permission(String request, String? option) => action(() async {
    if (acpId != null) {
      snapshot = await desktop.acpAction(acpId!, 'permission', {
        'requestId': request,
        'optionId': option,
      });
    }
  });
  Future<void> cancelWorker(String id) => action(() async {
    if (taskId != null) {
      snapshot = await desktop.taskAction(taskId!, 'cancel-worker', {'id': id});
    }
  });
  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    desktop.dispose();
    super.dispose();
  }
}
