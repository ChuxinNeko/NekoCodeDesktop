import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as hash;
import 'package:cryptography/cryptography.dart';
import 'package:pointycastle/export.dart' as pc;

import 'protocol.dart';
import 'storage.dart';

String b64(List<int> data) => base64UrlEncode(data).replaceAll('=', '');
Uint8List unb64(String data) => base64Url.decode(base64Url.normalize(data));
String publicId(String key) {
  final raw = unb64(key);
  if (raw.length != 65 || raw[0] != 4) throw ApiError('设备公钥格式不正确');
  pc.ECDomainParameters('prime256v1').curve.decodePoint(raw);
  return hash.sha256.convert(raw).toString();
}

Uint8List _bytes(BigInt value, int length) {
  final hex = value.toRadixString(16).padLeft(length * 2, '0');
  return Uint8List.fromList(
    List.generate(
      length,
      (i) => int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16),
    ),
  );
}

/// Wire-compatible with WebCrypto P-256 ECDH -> AES-256-GCM (no HKDF).
class RelayCrypto {
  RelayCrypto(this.store);
  final Store store;
  Json? _identity;
  Future<Json> identity() async {
    if (_identity != null) return _identity!;
    final domain = pc.ECDomainParameters('prime256v1');
    final saved = await store.readJson('relay-identity-v1');
    if (saved != null) {
      try {
        final scalar = BigInt.parse(saved['scalar'] as String, radix: 16);
        if (scalar > BigInt.zero && scalar < domain.n) {
          final key = b64((domain.G * scalar)!.getEncoded(false));
          if (key == saved['publicKey'] && publicId(key) == saved['id']) {
            return _identity = saved;
          }
        }
      } catch (_) {
        /* Corrupt identity is regenerated, not trusted. */
      }
    }
    final random = Random.secure();
    BigInt scalar;
    do {
      scalar = BigInt.parse(
        b64ToHex(List.generate(32, (_) => random.nextInt(256))),
        radix: 16,
      );
    } while (scalar == BigInt.zero || scalar >= domain.n);
    final key = b64((domain.G * scalar)!.getEncoded(false));
    final identity = {
      'version': 1,
      'scalar': scalar.toRadixString(16),
      'publicKey': key,
      'id': publicId(key),
    };
    await store.writeJson('relay-identity-v1', identity);
    return _identity = identity;
  }

  Future<SecretKey> derive(String peer) async {
    publicId(peer);
    final own = await identity();
    final domain = pc.ECDomainParameters('prime256v1');
    final point = domain.curve.decodePoint(unb64(peer));
    if (point == null || point.isInfinity) throw ApiError('设备公钥校验失败');
    final agreement = pc.ECDHBasicAgreement()
      ..init(
        pc.ECPrivateKey(
          BigInt.parse(own['scalar'] as String, radix: 16),
          domain,
        ),
      );
    return SecretKey(
      _bytes(agreement.calculateAgreement(pc.ECPublicKey(point, domain)), 32),
    );
  }

  List<int> aad(
    String connection,
    String desktop,
    String peer,
    String direction,
  ) => utf8.encode(
    'nekocode-relay-v1\u0000$connection\u0000$desktop\u0000$peer\u0000$direction',
  );
  Future<Json> encrypt(SecretKey key, Json value, List<int> aad) async {
    final bytes = utf8.encode(jsonEncode(value));
    if (bytes.length > 1024 * 1024) throw ApiError('中继消息过大');
    final box = await AesGcm.with256bits().encrypt(
      bytes,
      secretKey: key,
      aad: aad,
    );
    return {
      'version': 1,
      'iv': b64(box.nonce),
      'data': b64([...box.cipherText, ...box.mac.bytes]),
    };
  }

  Future<Json> decrypt(SecretKey key, Json value, List<int> aad) async {
    if (value['version'] != 1) throw ApiError('中继协议错误');
    final data = unb64(value['data'] as String);
    final nonce = unb64(value['iv'] as String);
    if (nonce.length != 12 ||
        data.length < 16 ||
        data.length > 1024 * 1024 + 16) {
      throw ApiError('中继消息格式不正确');
    }
    final bytes = await AesGcm.with256bits().decrypt(
      SecretBox(
        data.sublist(0, data.length - 16),
        nonce: nonce,
        mac: Mac(data.sublist(data.length - 16)),
      ),
      secretKey: key,
      aad: aad,
    );
    return object(jsonDecode(utf8.decode(bytes)));
  }
}

String b64ToHex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
