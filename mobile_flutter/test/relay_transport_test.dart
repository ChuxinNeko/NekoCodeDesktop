import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nekocode_mobile/core/account_client.dart';
import 'package:nekocode_mobile/core/protocol.dart';
import 'package:nekocode_mobile/core/relay_client.dart';
import 'package:nekocode_mobile/core/relay_crypto.dart';

import 'support.dart';

void main() {
  test('真实 WebSocket hello/ready/双向加密 frame/请求关联/断线', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final crypto = RelayCrypto(MemoryStore());
    final identity = await crypto.identity();
    final sockets = <WebSocket>[];
    server.listen((request) async {
      final socket = await WebSocketTransformer.upgrade(request);
      sockets.add(socket);
      String? peerId;
      String? publicKey;
      socket.listen((data) async {
        final message = object(jsonDecode(data as String));
        if (message['type'] == 'hello') {
          expect(message['protocol'], 1);
          expect(message['accessToken'], 'valid');
          peerId = object(message['peer'])['id'] as String;
          publicKey = object(message['peer'])['publicKey'] as String;
          socket.add(
            jsonEncode({
              'type': 'ready',
              'connectionId': '12345678-1234-1234-1234-123456789abc',
              'desktop': {
                'id': identity['id'],
                'publicKey': identity['publicKey'],
                'name': 'Test Desktop',
              },
            }),
          );
        } else if (message['type'] == 'frame') {
          final key = await crypto.derive(publicKey!);
          final aad = crypto.aad(
            '12345678-1234-1234-1234-123456789abc',
            identity['id'] as String,
            peerId!,
            'mobile-to-desktop',
          );
          final payload = await crypto.decrypt(
            key,
            object(message['payload']),
            aad,
          );
          expect(payload['path'], '/api/state');
          expect(payload['method'], 'GET');
          final sealed = await crypto.encrypt(
            key,
            {
              'id': payload['id'],
              'status': 200,
              'body': {'tasks': [], 'projects': []},
            },
            crypto.aad(
              '12345678-1234-1234-1234-123456789abc',
              identity['id'] as String,
              peerId!,
              'desktop-to-mobile',
            ),
          );
          socket.add(jsonEncode({'type': 'frame', 'payload': sealed}));
        }
      });
    });
    final store = MemoryStore();
    final account = AccountClient(store);
    account.session = {
      'email': 'test@example.com',
      'accessToken': 'valid',
      'refreshToken': 'unused',
      'expiresAt': DateTime.now().millisecondsSinceEpoch + 3600000,
    };
    final relay = RelayClient(
      store,
      account,
      endpoint: 'ws://127.0.0.1:${server.port}',
    );
    addTearDown(() async {
      relay.close();
      account.dispose();
      for (final s in sockets) {
        await s.close();
      }
      await server.close(force: true);
    });
    await relay.select({
      'id': identity['id'],
      'publicKey': identity['publicKey'],
      'name': 'Test Desktop',
    });
    final responses = await Future.wait([
      relay.request('/api/state'),
      relay.request('/api/state'),
    ]);
    expect(responses, [
      {'tasks': [], 'projects': []},
      {'tasks': [], 'projects': []},
    ]);
    await relay.forget();
    expect(relay.binding, isNull);
  });
}
