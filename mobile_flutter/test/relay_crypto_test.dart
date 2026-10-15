import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nekocode_mobile/core/protocol.dart';
import 'package:nekocode_mobile/core/relay_crypto.dart';

import 'support.dart';

void main() {
  test('与真实 Node WebCrypto P-256/AES-GCM 向量互操作，篡改拒绝解密', () async {
    final vector = object(
      jsonDecode(File('test/fixtures/webcrypto.json').readAsStringSync()),
    );
    final store = MemoryStore();
    await store.write(
      'relay-identity-v1',
      jsonEncode({
        'version': 1,
        'id': vector['id'],
        'publicKey': vector['publicKey'],
        'scalar': vector['scalar'],
      }),
    );
    final crypto = RelayCrypto(store);
    final key = await crypto.derive(vector['peerPublicKey'] as String);
    expect(b64ToHex(await key.extractBytes()), vector['shared']);
    final aad = crypto.aad(
      'connection',
      'desktop',
      'peer',
      'desktop-to-mobile',
    );
    expect(
      await crypto.decrypt(key, object(vector['cipher']), aad),
      vector['plain'],
    );
    await expectLater(
      crypto.decrypt(
        key,
        object(vector['cipher']),
        crypto.aad('other', 'desktop', 'peer', 'desktop-to-mobile'),
      ),
      throwsA(anything),
    );
    final encrypted = await crypto.encrypt(key, {'hello': '世界'}, aad);
    expect(await crypto.decrypt(key, encrypted, aad), {'hello': '世界'});
    expect(publicId(vector['publicKey'] as String), vector['id']);
  });
}
