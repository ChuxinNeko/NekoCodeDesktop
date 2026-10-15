import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'protocol.dart';
import 'storage.dart';

class AccountClient {
  AccountClient(
    this.store, {
    http.Client? client,
    this.baseUrl = 'https://codeapi.nekofun.top',
  }) : client = client ?? http.Client();
  final Store store;
  final http.Client client;
  final String baseUrl;
  Json? session;
  Future<Json?>? _refreshing;
  String? get email => session?['email'] as String?;
  bool get signedIn => session != null;

  Future<void> restore() async {
    final saved = await store.readJson('account');
    session =
        saved != null &&
            saved['accessToken'] is String &&
            saved['refreshToken'] is String &&
            saved['email'] is String &&
            saved['expiresAt'] is num
        ? saved
        : null;
  }

  Future<void> _persist(Json? value) async {
    session = value;
    await store.writeJson('account', value);
  }

  Future<void> _tokens(Json tokens) => _persist({
    'accessToken': tokens['accessToken'],
    'refreshToken': tokens['refreshToken'],
    'expiresAt':
        DateTime.now().millisecondsSinceEpoch +
        (tokens['expiresIn'] as num).toInt() * 1000,
    'email': object(tokens['user'])['email'],
  });

  Future<dynamic> call(
    String path, {
    String method = 'POST',
    Json? body,
    String? token,
  }) async {
    http.Response response;
    try {
      final request = http.Request(method, Uri.parse('$baseUrl$path'))
        ..followRedirects = false;
      if (body != null) {
        request.headers['Content-Type'] = 'application/json';
        request.body = jsonEncode(body);
      }
      if (token != null) request.headers['Authorization'] = 'Bearer $token';
      response = await http.Response.fromStream(
        await client.send(request).timeout(const Duration(seconds: 20)),
      ).timeout(const Duration(seconds: 20));
    } catch (_) {
      throw ApiError('无法连接服务器，请检查网络', code: 'network');
    }
    dynamic payload;
    try {
      payload = response.body.isEmpty ? null : jsonDecode(response.body);
    } catch (_) {
      payload = null;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final error = object(object(payload)['error']);
      throw ApiError(
        string(error['message'], '请求失败'),
        status: response.statusCode,
        code: string(error['code'], 'server_error'),
      );
    }
    return payload;
  }

  Future<Json?> refresh() =>
      _refreshing ??= _refresh().whenComplete(() => _refreshing = null);
  Future<Json?> _refresh() async {
    final original = session;
    if (original == null) return null;
    try {
      final tokens = object(
        await call(
          '/auth/refresh',
          body: {'refreshToken': original['refreshToken']},
        ),
      );
      if (!identical(session, original)) return session;
      await _tokens(tokens);
      return session;
    } on ApiError catch (e) {
      if (e.code != 'network' && identical(session, original)) {
        await _persist(null);
      }
      rethrow;
    }
  }

  Future<String> access({bool force = false}) async {
    if (session == null) throw ApiError('请先登录', status: 401);
    if (force ||
        (session!['expiresAt'] as num) - 60000 <=
            DateTime.now().millisecondsSinceEpoch) {
      await refresh();
    }
    if (session == null) throw ApiError('登录状态已失效，请重新登录', status: 401);
    return session!['accessToken'] as String;
  }

  Future<dynamic> authed(
    String path, {
    String method = 'GET',
    Json? body,
  }) async {
    final token = await access();
    try {
      return await call(path, method: method, body: body, token: token);
    } on ApiError catch (e) {
      if (e.status != 401) rethrow;
      return call(
        path,
        method: method,
        body: body,
        token: await access(force: true),
      );
    }
  }

  Future<void> login(String email, String password) async => _tokens(
    object(
      await call(
        '/auth/login',
        body: {'email': email.trim(), 'password': password},
      ),
    ),
  );
  Future<void> register(String email, String password) async {
    await call(
      '/auth/register',
      body: {'email': email.trim(), 'password': password},
    );
  }

  Future<void> verify(String email, String code) async => _tokens(
    object(
      await call(
        '/auth/verify',
        body: {'email': email.trim(), 'code': code.trim()},
      ),
    ),
  );
  Future<void> resend(String email) async {
    await call('/auth/resend', body: {'email': email.trim()});
  }

  Future<void> forgot(String email) async {
    await call('/auth/forgot', body: {'email': email.trim()});
  }

  Future<void> reset(String email, String code, String password) async {
    await call(
      '/auth/reset',
      body: {
        'email': email.trim(),
        'code': code.trim(),
        'newPassword': password,
      },
    );
  }

  Future<List<Json>> devices() async {
    final value = object(await authed('/relay/devices'))['devices'];
    if (value is! List || value.length > 20) throw ApiError('服务器返回了无法识别的设备列表');
    return records(value);
  }

  Future<void> logout() async {
    final token = session?['refreshToken'];
    await _persist(null);
    if (token != null) {
      try {
        await call('/auth/logout', body: {'refreshToken': token});
      } catch (_) {}
    }
  }

  void dispose() => client.close();
}
