import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'protocol.dart';

abstract interface class Store {
  Future<String?> read(String key);
  Future<void> write(String key, String? value);
}

class SecureStore implements Store {
  const SecureStore();
  static const _storage = FlutterSecureStorage();
  @override
  Future<String?> read(String key) => _storage.read(key: key);
  @override
  Future<void> write(String key, String? value) => value == null
      ? _storage.delete(key: key)
      : _storage.write(key: key, value: value);
}

extension JsonStore on Store {
  Future<Json?> readJson(String key) async {
    final value = await read(key);
    try {
      return value == null ? null : object(jsonDecode(value));
    } catch (_) {
      return null;
    }
  }

  Future<void> writeJson(String key, Json? value) =>
      write(key, value == null ? null : jsonEncode(value));
}
