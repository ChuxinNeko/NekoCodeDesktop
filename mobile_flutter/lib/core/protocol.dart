import 'dart:convert';

typedef Json = Map<String, dynamic>;

Json object(dynamic value) =>
    value is Map ? Map<String, dynamic>.from(value) : {};
List<Json> records(dynamic value) =>
    value is List ? value.map(object).toList() : [];
String string(dynamic value, [String fallback = '']) =>
    value is String ? value : fallback;

class ApiError implements Exception {
  ApiError(this.message, {this.status, this.code});
  final String message;
  final int? status;
  final String? code;
  @override
  String toString() => message;
}

String normalizeDesktopAddress(String value) {
  final uri = Uri.tryParse(value.contains('://') ? value : 'http://$value');
  if (uri == null) throw ApiError('请输入电脑显示的局域网地址');
  final parts = uri.host.split('.').map(int.tryParse).toList();
  final ipv4 =
      parts.length == 4 && parts.every((p) => p != null && p >= 0 && p <= 255);
  final local =
      ipv4 &&
      (parts[0] == 10 ||
          parts[0] == 127 ||
          (parts[0] == 192 && parts[1] == 168) ||
          (parts[0] == 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
          (parts[0] == 169 && parts[1] == 254) ||
          (parts[0] == 100 && parts[1]! >= 64 && parts[1]! <= 127));
  if (uri.scheme != 'http' ||
      (!local && uri.host != 'localhost') ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.path.isNotEmpty && uri.path != '/')) {
    throw ApiError('请输入电脑显示的局域网地址，例如 http://192.168.1.8:47832');
  }
  return Uri(
    scheme: 'http',
    host: uri.host,
    port: uri.hasPort ? uri.port : 47832,
  ).origin;
}

Json parsePairing(String text, {DateTime? now}) {
  if (text.length > 2048) throw ApiError('请扫描 NekoCode 电脑端的配对二维码');
  Json data;
  try {
    data = object(jsonDecode(text));
  } catch (_) {
    throw ApiError('请扫描 NekoCode 电脑端的配对二维码');
  }
  if (data['type'] != 'nekocode.lan-pairing' ||
      data['version'] != 1 ||
      data['endpoint'] is! String ||
      data['code'] is! String ||
      !RegExp(r'^[A-F0-9]{10}$').hasMatch(data['code'] as String) ||
      data['expiresAt'] is! int) {
    throw ApiError('配对二维码格式不正确，请在电脑端重新生成');
  }
  if ((data['expiresAt'] as int) <=
      (now ?? DateTime.now()).millisecondsSinceEpoch) {
    throw ApiError('配对二维码已过期，请在电脑端重新生成');
  }
  return {
    ...data,
    'endpoint': normalizeDesktopAddress(data['endpoint'] as String),
  };
}

Json? applySnapshotDelta(Json? base, Json delta) {
  if (delta['full'] is Map) return object(delta['full']);
  if (base == null) return null;
  final byId = {for (final cell in records(base['cells'])) cell['id']: cell};
  for (final cell in records(delta['cells'])) {
    byId[cell['id']] = cell;
  }
  final List<Json> cells = [];
  if (delta['order'] is List) {
    for (final id in delta['order'] as List) {
      if (!byId.containsKey(id)) return null;
      cells.add(byId[id]!);
    }
  } else {
    cells.addAll(records(base['cells']).map((cell) => byId[cell['id']]!));
  }
  final rest = Map<String, dynamic>.from(base)
    ..remove('cells')
    ..remove('models')
    ..remove('checkpoints');
  return {
    ...(delta['rest'] is Map ? object(delta['rest']) : rest),
    'cells': cells,
    'models': delta['models'] ?? base['models'],
    'checkpoints': delta['checkpoints'] ?? base['checkpoints'],
  };
}
