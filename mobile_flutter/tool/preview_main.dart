// Local-only design preview harness (not part of the app).
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:nekocode_mobile/app.dart';
import 'package:nekocode_mobile/core/desktop_client.dart';
import 'package:nekocode_mobile/core/storage.dart';
import 'package:nekocode_mobile/features/mobile_controller.dart';
import 'package:shared_preferences/shared_preferences.dart';

class MemoryStore implements Store {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String? value) async {
    if (value == null) {
      values.remove(key);
    } else {
      values[key] = value;
    }
  }
}

final now = DateTime.now().millisecondsSinceEpoch;
final tasksData = [
  {'id': 't1', 'title': '修复购物车结算金额错误', 'cwd': '/home/neko/projects/shop-api', 'running': true, 'preview': '正在运行测试…', 'updatedAt': now - 60000},
  {'id': 't2', 'title': '重构登录模块并补充单元测试', 'cwd': '/home/neko/projects/shop-api', 'running': false, 'preview': '已完成 4 项修改', 'updatedAt': now - 3600000},
  {'id': 't3', 'title': '为 README 添加部署说明', 'cwd': '/home/neko/projects/shop-api', 'running': false, 'preview': '', 'updatedAt': now - 86400000 * 2},
  {'id': 't4', 'title': '调研 Fusion 模式卡顿原因', 'cwd': '/home/neko/projects/NekoCodeDesktop', 'running': false, 'preview': '根因已定位', 'updatedAt': now - 7200000},
  {'id': 't5', 'title': '新会话', 'titlePending': true, 'cwd': '/home/neko/projects/NekoCodeDesktop', 'running': false, 'updatedAt': now - 86400000 * 5},
];
final cells = [
  {'id': '1', 'type': 'user', 'text': '购物车结算的时候优惠券会被重复计算，帮我看一下 cart.ts'},
  {'id': '2', 'type': 'assistant', 'thinking': '先读取 cart.ts，再搜索 applyCoupon 的调用点。', 'text': '好的，我先看一下 `cart.ts` 里优惠券的计算逻辑。'},
  {'id': '3', 'type': 'tool', 'name': 'read', 'status': 'done', 'input': {'path': 'src/cart.ts'}, 'output': 'export function total(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}'},
  {'id': '4', 'type': 'tool', 'name': 'grep', 'status': 'done', 'input': {'pattern': 'applyCoupon'}, 'output': 'src/cart.ts:12\nsrc/checkout.ts:44'},
  {'id': '5', 'type': 'tool', 'name': 'bash', 'status': 'done', 'input': {'command': 'bun test src/cart.test.ts', 'cwd': '/home/neko/projects/shop-api'}, 'output': '✓ total sums items\n✗ coupon applied once\n\n1 fail, 1 pass'},
  {'id': '6', 'type': 'assistant', 'text': '找到问题了：`applyCoupon` 在 `total()` 与 `checkout()` 里各调用了一次。\n\n**修复方案**\n\n1. 只在 `checkout()` 中计算优惠\n2. 为 `total()` 增加回归测试\n\n```ts\nexport function total(items: Item[]) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n```\n\n> 注意：已有订单不受影响。', 'usage': {'totalTokens': 12840, 'calls': 4, 'durationMs': 18400}},
  {'id': '7', 'type': 'tool', 'name': 'bash', 'status': 'running', 'input': {'command': 'bun test'}, 'output': ''},
];

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final desktop = DesktopClient(MemoryStore());
  final c = MobileController(desktop)..ready = true;
  final dark = ValueNotifier<bool>(false);
  var last = '';
  Timer.periodic(const Duration(milliseconds: 400), (_) async {
    final prefs = await SharedPreferences.getInstance();
    final f = File('/data/scene.txt');
    if (!f.existsSync()) return;
    final s = f.readAsStringSync().trim();
    if (s == last) return;
    last = s;
    final parts = s.split(' ');
    final scene = parts.first;
    final wantDark = parts.contains('dark');
    await prefs.setString('appearance', wantDark ? 'dark' : 'light');
    if (scene == 'pair') {
      desktop.mode = null;
      c.online = false;
      c.view = 'tasks';
    } else {
      desktop.mode = 'lan';
      desktop.lan = {'name': 'Neko-PC', 'endpoint': 'http://192.168.1.8:47832', 'token': 'x'};
      c.online = true;
      c.tasks = tasksData.map((e) => Map<String, dynamic>.from(e)).toList();
      c.projects = [
        {'id': 'p1', 'name': 'shop-api', 'path': '/home/neko/projects/shop-api'},
        {'id': 'p2', 'name': 'NekoCodeDesktop', 'path': '/home/neko/projects/NekoCodeDesktop'},
      ];
      c.view = scene == 'chat' ? 'chat' : scene == 'settings' ? 'settings' : 'tasks';
      if (scene == 'chat') {
        c.taskId = 't1';
        c.snapshot = {
          'title': '修复购物车结算金额错误',
          'cells': cells,
          'models': [],
          'thinkingLevels': ['off', 'low', 'high'],
          'streaming': true,
        };
      }
    }
    dark.value = wantDark;
    c.emit();
  });
  runApp(ValueListenableBuilder<bool>(
    valueListenable: dark,
    builder: (_, d, __) => NekoCodeApp(key: ValueKey(d), controller: c, initialize: false),
  ));
}
