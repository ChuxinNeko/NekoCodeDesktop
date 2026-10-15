import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:uuid/uuid.dart';

import 'account_client.dart';
import 'protocol.dart';
import 'relay_crypto.dart';
import 'storage.dart';

class RelayClient {
  RelayClient(
    this.store,
    this.account, {
    this.endpoint = 'wss://codeapi.nekofun.top/relay/mobile',
  }) : crypto = RelayCrypto(store);
  final String endpoint;
  final Store store;
  final AccountClient account;
  final RelayCrypto crypto;
  Json? binding;
  WebSocket? _socket;
  SecretKey? _key;
  String? _connection;
  Future<void>? _connecting;
  Timer? _ping;
  int _generation = 0;
  bool _forceRefresh = false;
  final _pending = <String, Completer<dynamic>>{};

  Future<void> restore() async {
    final saved = await store.readJson('relay-binding');
    try {
      final desktop = object(saved?['desktop']);
      if (account.email != null &&
          saved?['accountEmail'] == account.email &&
          publicId(desktop['publicKey'] as String) == desktop['id']) {
        binding = saved;
      }
    } catch (_) {
      binding = null;
    }
  }

  Future<List<Json>> devices() async {
    final devices = await account.devices();
    for (final d in devices) {
      if (d['publicKey'] is! String ||
          publicId(d['publicKey'] as String) != d['id'] ||
          d['name'] is! String ||
          d['online'] is! bool ||
          DateTime.tryParse(string(d['lastSeenAt'])) == null) {
        throw ApiError('设备公钥或设备列表校验失败');
      }
    }
    return devices;
  }

  Future<void> select(Json device) async {
    if (account.email == null) throw ApiError('请先登录', status: 401);
    if (publicId(device['publicKey'] as String) != device['id']) {
      throw ApiError('设备公钥校验失败');
    }
    close();
    binding = {
      'accountEmail': account.email,
      'desktop': {
        'id': device['id'],
        'name': device['name'],
        'publicKey': device['publicKey'],
      },
    };
    await store.writeJson('relay-binding', binding);
  }

  void close([ApiError? error]) {
    _generation++;
    _ping?.cancel();
    _ping = null;
    final socket = _socket;
    _socket = null;
    _key = null;
    _connection = null;
    _connecting = null;
    unawaited(socket?.close());
    for (final pending in _pending.values) {
      if (!pending.isCompleted) {
        pending.completeError(error ?? ApiError('连接已断开'));
      }
    }
    _pending.clear();
  }

  Future<void> forget() async {
    close();
    binding = null;
    await store.write('relay-binding', null);
  }

  Future<void> connect() {
    if (_key != null) return Future.value();
    return _connecting ??= _open().whenComplete(() => _connecting = null);
  }

  Future<void> _open() async {
    if (binding == null) throw ApiError('请先选择电脑', status: 401);
    final generation = _generation;
    final desktop = object(binding!['desktop']);
    final token = await account.access(force: _forceRefresh);
    _forceRefresh = false;
    final identity = await crypto.identity();
    if (_generation != generation) throw ApiError('连接已取消');
    final socket = await WebSocket.connect(endpoint)
        .timeout(const Duration(seconds: 20));
    if (_generation != generation) {
      await socket.close();
      throw ApiError('连接已取消');
    }
    _socket = socket;
    final ready = Completer<void>();
    ApiError? serverError;
    socket.listen(
      (raw) async {
        if (_socket != socket || raw is! String) return;
        try {
          final message = object(jsonDecode(raw));
          if (message['type'] == 'pong') return;
          if (message['type'] == 'error') {
            final code = message['code'];
            serverError = ApiError(
              string(message['message'], '中继连接失败'),
              status: code == 'unauthorized'
                  ? 401
                  : code == 'forbidden'
                  ? 403
                  : 503,
            );
            return;
          }
          if (message['type'] == 'ready') {
            if (_key != null) return;
            final peer = object(message['desktop']);
            if (!RegExp(
                  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                ).hasMatch(string(message['connectionId'])) ||
                peer['id'] != desktop['id'] ||
                peer['publicKey'] != desktop['publicKey'] ||
                publicId(peer['publicKey'] as String) != peer['id']) {
              throw ApiError('中继设备身份校验失败');
            }
            final key = await crypto.derive(peer['publicKey'] as String);
            if (_socket != socket) return;
            _key = key;
            _connection = message['connectionId'] as String;
            _ping = Timer.periodic(const Duration(seconds: 25), (_) {
              if (_socket == socket) socket.add(jsonEncode({'type': 'ping'}));
            });
            if (!ready.isCompleted) ready.complete();
            return;
          }
          if (message['type'] == 'frame' && _key != null) {
            try {
              final response = await crypto.decrypt(
                _key!,
                object(message['payload']),
                crypto.aad(
                  _connection!,
                  desktop['id'] as String,
                  identity['id'] as String,
                  'desktop-to-mobile',
                ),
              );
              final status = response['status'];
              if (status is! int || status < 100 || status > 599) return;
              final pending = _pending.remove(response['id']);
              if (pending == null) return;
              if (status >= 200 && status < 300) {
                pending.complete(response['body']);
              } else {
                pending.completeError(
                  ApiError(
                    string(object(response['body'])['error'], '请求失败'),
                    status: status,
                  ),
                );
              }
            } catch (_) {
              /* Invalid encrypted frame cannot fulfill a request. */
            }
            return;
          }
          throw ApiError('中继协议错误');
        } catch (e) {
          if (!ready.isCompleted) ready.completeError(e);
          if (_socket == socket) close(ApiError('中继协议错误'));
        }
      },
      onError: (Object e) {
        if (!ready.isCompleted) ready.completeError(ApiError('中继连接失败'));
        if (_socket == socket) close();
      },
      onDone: () {
        final code = socket.closeCode;
        final error =
            serverError ??
            ApiError(
              code == 4401
                  ? '登录状态已失效'
                  : code == 4404
                  ? '桌面端不在线'
                  : '连接中断',
              status: code == 4401
                  ? 401
                  : code == 4404
                  ? 503
                  : null,
            );
        if (error.status == 401) _forceRefresh = true;
        if (!ready.isCompleted) ready.completeError(error);
        if (_socket == socket) close(error);
      },
    );
    socket.add(
      jsonEncode({
        'type': 'hello',
        'protocol': 1,
        'accessToken': token,
        'desktopId': desktop['id'],
        'peer': {'id': identity['id'], 'publicKey': identity['publicKey']},
      }),
    );
    try {
      await ready.future.timeout(const Duration(seconds: 20));
    } catch (_) {
      if (_socket == socket) close();
      rethrow;
    }
  }

  Future<dynamic> request(String path, [Json? body]) async {
    await connect();
    if (_pending.length >= 100) throw ApiError('请求过于频繁，请稍后再试', status: 429);
    final socket = _socket;
    final key = _key;
    final connection = _connection;
    if (socket == null || key == null || connection == null) {
      throw ApiError('连接中断');
    }
    final identity = await crypto.identity();
    final id = const Uuid().v4();
    final desktop = object(binding!['desktop']);
    final payload = await crypto.encrypt(
      key,
      {
        'id': id,
        'method': body == null ? 'GET' : 'POST',
        'path': path,
        'body': ?body,
      },
      crypto.aad(
        connection,
        desktop['id'] as String,
        identity['id'] as String,
        'mobile-to-desktop',
      ),
    );
    if (_socket != socket) throw ApiError('连接已切换');
    final pending = Completer<dynamic>();
    _pending[id] = pending;
    socket.add(jsonEncode({'type': 'frame', 'payload': payload}));
    try {
      return await pending.future.timeout(
        const Duration(seconds: 20),
        onTimeout: () => throw ApiError('请求超时，请检查电脑连接'),
      );
    } finally {
      _pending.remove(id);
    }
  }
}
