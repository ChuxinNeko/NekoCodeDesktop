import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nekocode_mobile/core/protocol.dart';
import 'package:nekocode_mobile/core/desktop_client.dart';
import 'package:nekocode_mobile/core/account_client.dart';

import 'support.dart';

void main() {
  test('配对限定本地地址，拒绝重定向目标、凭据、路径及过期二维码', () {
    expect(normalizeDesktopAddress('192.168.1.8'), 'http://192.168.1.8:47832');
    expect(
      normalizeDesktopAddress('100.64.0.1:9000'),
      'http://100.64.0.1:9000',
    );
    for (final value in [
      'https://192.168.1.8',
      'example.com',
      'http://user@127.0.0.1',
      'http://127.0.0.1/path',
      'http://127.0.0.1?x=1',
      'http://127.0.0.1#x',
    ]) {
      expect(() => normalizeDesktopAddress(value), throwsA(isA<ApiError>()));
    }
    final qr = {
      'type': 'nekocode.lan-pairing',
      'version': 1,
      'endpoint': '192.168.1.8',
      'code': 'ABCDEF0123',
      'expiresAt': 2000,
    };
    expect(
      parsePairing(
        jsonEncode(qr),
        now: DateTime.fromMillisecondsSinceEpoch(1000),
      )['code'],
      'ABCDEF0123',
    );
    expect(
      () => parsePairing(
        jsonEncode(qr),
        now: DateTime.fromMillisecondsSinceEpoch(2000),
      ),
      throwsA(isA<ApiError>()),
    );
  });
  test('增量更新、排序删除及缺失基线恢复信号', () {
    final base = {
      'cells': [
        {'id': 'a', 'text': 'old'},
        {'id': 'b'},
      ],
      'models': [],
      'checkpoints': [],
      'streaming': true,
    };
    expect(
      applySnapshotDelta(base, {
        'cells': [
          {'id': 'a', 'text': 'new'},
        ],
        'order': ['a'],
        'rest': {'streaming': false},
      })!['cells'],
      [
        {'id': 'a', 'text': 'new'},
      ],
    );
    expect(
      applySnapshotDelta(base, {
        'order': ['missing'],
      }),
      isNull,
    );
    expect(applySnapshotDelta(null, {'cells': []}), isNull);
  });
  test('发送失败保留 requestId，重试不重复创建任务', () async {
    final store = MemoryStore();
    final ids = <String>[];
    final desktop =
        DesktopClient(
            store,
            httpClient: MockClient((req) async {
              expect(req.headers['Authorization'], 'Bearer token');
              ids.add(jsonDecode(req.body)['requestId'] as String);
              return ids.length == 1
                  ? http.Response('{"error":"temporarily unavailable"}', 503)
                  : http.Response('{"id":"t","accepted":true}', 200);
            }),
          )
          ..mode = 'lan'
          ..lan = {'endpoint': 'http://127.0.0.1:47832', 'token': 'token'};
    await expectLater(
      desktop.submit('/api/tasks', {'projectId': 'p', 'text': 'hello'}),
      throwsA(isA<ApiError>()),
    );
    await desktop.submit('/api/tasks', {'projectId': 'p', 'text': 'hello'});
    expect(ids[0], ids[1]);
    expect(await store.read('pending-message'), isNull);
    desktop.dispose();
  });
  test('并发过期 token 只刷新一次且刷新网络失败不删除会话', () async {
    final store = MemoryStore();
    var count = 0;
    final account = AccountClient(
      store,
      client: MockClient((req) async {
        if (req.url.path == '/auth/refresh') {
          count++;
          await Future<void>.delayed(const Duration(milliseconds: 10));
          return http.Response(
            jsonEncode({
              'accessToken': 'new',
              'refreshToken': 'rotated',
              'expiresIn': 3600,
              'user': {'email': 'a@b.com'},
            }),
            200,
          );
        }
        expect(req.headers['Authorization'], 'Bearer new');
        return http.Response('{}', 200);
      }),
    );
    account.session = {
      'accessToken': 'old',
      'refreshToken': 'refresh',
      'email': 'a@b.com',
      'expiresAt': 0,
    };
    await Future.wait([account.authed('/auth/me'), account.authed('/auth/me')]);
    expect(count, 1);
    account.dispose();
    final offline = AccountClient(
      store,
      client: MockClient((_) async => throw Exception('offline')),
    );
    offline.session = {
      'accessToken': 'old',
      'refreshToken': 'refresh',
      'email': 'a@b.com',
      'expiresAt': 0,
    };
    await expectLater(offline.access(), throwsA(isA<ApiError>()));
    expect(offline.signedIn, isTrue);
    offline.dispose();
  });
}
