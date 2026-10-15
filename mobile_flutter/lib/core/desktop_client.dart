import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

import 'account_client.dart';
import 'protocol.dart';
import 'relay_client.dart';
import 'storage.dart';

class DesktopClient {
  DesktopClient(
    this.store, {
    http.Client? httpClient,
    AccountClient? accountClient,
  }) : httpClient = httpClient ?? http.Client() {
    account = accountClient ?? AccountClient(store);
    relay = RelayClient(store, account);
  }
  final Store store;
  final http.Client httpClient;
  late final AccountClient account;
  late final RelayClient relay;
  Json? lan;
  String? mode;
  int generation = 0;
  Json? _snapshot;
  String? _sessionId, _version;
  bool more = false;
  Future<void> _queue = Future.value();
  String get name => mode == 'lan'
      ? string(lan?['name'])
      : string(object(relay.binding?['desktop'])['name']);
  String get endpoint => mode == 'lan' ? string(lan?['endpoint']) : '公网中继';

  Future<void> restore() async {
    await account.restore();
    await relay.restore();
    final saved = await store.readJson('lan-binding');
    if (saved != null) {
      try {
        if (RegExp(r'^[a-f0-9]{64}$').hasMatch(string(saved['token']))) {
          lan = {
            ...saved,
            'endpoint': normalizeDesktopAddress(saved['endpoint'] as String),
          };
        }
      } catch (_) {
        lan = null;
      }
    }
    final preferred = await store.read('transport');
    mode = preferred == 'relay' && relay.binding != null
        ? 'relay'
        : preferred == 'lan' && lan != null
        ? 'lan'
        : lan != null
        ? 'lan'
        : relay.binding != null
        ? 'relay'
        : null;
  }

  Future<dynamic> lanRequest(String path, Json? body, Json binding) async {
    final request = http.Request(
      body == null ? 'GET' : 'POST',
      Uri.parse('${binding['endpoint']}$path'),
    )..followRedirects = false;
    if (string(binding['token']).isNotEmpty) {
      request.headers['Authorization'] = 'Bearer ${binding['token']}';
    }
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    final response = await http.Response.fromStream(
      await httpClient.send(request).timeout(const Duration(seconds: 7)),
    ).timeout(const Duration(seconds: 20));
    dynamic value;
    try {
      value = jsonDecode(response.body);
    } catch (_) {
      throw ApiError('电脑返回了无法识别的响应', status: response.statusCode);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiError(
        string(object(value)['error'], '连接失败'),
        status: response.statusCode,
      );
    }
    return value;
  }

  Future<void> pair(String endpoint, String code, String name) async {
    final binding = {
      'endpoint': normalizeDesktopAddress(endpoint.trim()),
      'token': '',
      'name': 'NekoCode Desktop',
    };
    final info = object(await lanRequest('/api/info', null, binding));
    if (info['protocol'] != 1) throw ApiError('电脑与手机版本不兼容，请更新应用');
    final result = object(
      await lanRequest('/api/pair', {
        'code': code.trim(),
        'name': name.trim().isEmpty ? '我的手机' : name.trim(),
      }, binding),
    );
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(string(result['token']))) {
      throw ApiError('电脑返回的配对凭据格式错误');
    }
    lan = {...binding, 'token': result['token'], 'name': info['name']};
    await store.writeJson('lan-binding', lan);
    await store.write('pending-message', null);
    await switchMode('lan');
  }

  Future<void> selectRelay(Json device) async {
    await relay.select(device);
    await switchMode('relay');
  }

  Future<void> switchMode(String value) async {
    if ((value == 'lan' && lan == null) ||
        (value == 'relay' && relay.binding == null)) {
      throw ApiError('没有可用的连接');
    }
    if (value == 'lan') relay.close();
    generation++;
    forgetSync();
    mode = value;
    await store.write('transport', value);
  }

  Future<void> deactivate() async {
    relay.close();
    generation++;
    mode = null;
    forgetSync();
    await store.write('transport', null);
  }

  Future<void> disconnect() async {
    if (mode == 'lan') {
      lan = null;
      await store.write('lan-binding', null);
    } else if (mode == 'relay') {
      await relay.forget();
    }
    generation++;
    forgetSync();
    mode = lan != null
        ? 'lan'
        : relay.binding != null
        ? 'relay'
        : null;
    await store.write('transport', mode);
    await store.write('pending-message', null);
  }

  Future<dynamic> request(String path, [Json? body]) {
    if (mode == 'relay') return relay.request(path, body);
    if (mode == 'lan' && lan != null) return lanRequest(path, body, lan!);
    throw ApiError('请先绑定电脑', status: 401);
  }

  Future<Json> submit(String path, Json payload) async {
    final saved = await store.readJson('pending-message');
    final identity = mode == 'lan'
        ? (lan?['token'])
        : object(relay.binding?['desktop'])['id'];
    final scope = '$mode:$identity';
    final submission =
        saved?['scope'] == scope &&
            saved?['path'] == path &&
            jsonEncode(saved?['payload']) == jsonEncode(payload)
        ? saved!
        : {
            'scope': scope,
            'path': path,
            'payload': payload,
            'requestId': const Uuid().v4(),
          };
    await store.writeJson('pending-message', submission);
    final result = object(
      await request(path, {...payload, 'requestId': submission['requestId']}),
    );
    await store.write('pending-message', null);
    return result;
  }

  void forgetSync() {
    _snapshot = null;
    _sessionId = null;
    _version = null;
    more = false;
  }

  Future<Json> sync(String id, {int back = 0}) {
    final completer = Completer<Json>();
    final marker = generation;
    _queue = _queue.then((_) async {
      try {
        if (marker != generation) throw ApiError('连接已切换');
        final held = _sessionId == id ? _snapshot : null;
        var delta = object(
          await request('/api/tasks/${Uri.encodeComponent(id)}/delta', {
            if (held != null) 'since': _version,
            if (held != null && records(held['cells']).isNotEmpty)
              'from': records(held['cells']).first['id'],
            if (back > 0) 'back': back,
          }),
        );
        var next = applySnapshotDelta(held, delta);
        if (next == null) {
          delta = object(
            await request('/api/tasks/${Uri.encodeComponent(id)}/delta', {}),
          );
          next = applySnapshotDelta(null, delta);
        }
        if (next == null) throw ApiError('会话同步失败，请重新打开任务');
        if (marker != generation) throw ApiError('连接已切换');
        _snapshot = next;
        _sessionId = id;
        _version = string(delta['version']);
        more = delta['more'] == true;
        completer.complete(next);
      } catch (e, stack) {
        completer.completeError(e, stack);
      }
    });
    return completer.future;
  }

  Future<Json> state() async => object(await request('/api/state'));
  Future<Json> defaults(String id) async => object(
    await request('/api/projects/${Uri.encodeComponent(id)}/defaults'),
  );
  Future<Json> taskAction(String id, String action, Json body) async => object(
    await request('/api/tasks/${Uri.encodeComponent(id)}/$action', body),
  );
  Future<Json> acpAction(String id, String action, Json body) async => object(
    await request('/api/acp/sessions/${Uri.encodeComponent(id)}/$action', body),
  );
  void dispose() {
    relay.close();
    account.dispose();
    httpClient.close();
  }
}
