import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/protocol.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';
import 'account_view.dart';

class PairingView extends StatefulWidget {
  const PairingView({super.key, required this.controller});
  final MobileController controller;
  @override
  State<PairingView> createState() => _PairingViewState();
}

class _PairingViewState extends State<PairingView> {
  final endpoint = TextEditingController(),
      code = TextEditingController(),
      name = TextEditingController(text: '我的手机');
  int tab = 0;
  MobileController get c => widget.controller;
  @override
  void dispose() {
    endpoint.dispose();
    code.dispose();
    name.dispose();
    super.dispose();
  }

  Future<void> scan() async {
    final text = await Navigator.of(context)
        .push<String>(MaterialPageRoute(builder: (_) => const ScannerPage()));
    if (text == null || !mounted) return;
    try {
      final value = parsePairing(text);
      endpoint.text = value['endpoint'] as String;
      code.text = value['code'] as String;
      await c.pairedLan(endpoint.text, code.text, name.text);
    } catch (e) {
      c.error = '$e';
      c.emit();
    }
  }

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(24),
    children: [
      const SizedBox(height: 24),
      Text('NekoCode', style: Theme.of(context).textTheme.headlineMedium),
      const SizedBox(height: 8),
      const Text('连接桌面，继续你的任务'),
      const SizedBox(height: 40),
      SegmentedButton<int>(
        segments: const [
          ButtonSegment(value: 0, label: Text('扫码配对')),
          ButtonSegment(value: 1, label: Text('手动配置')),
          ButtonSegment(value: 2, label: Text('公网连接')),
        ],
        selected: {tab},
        onSelectionChanged: c.busy
            ? null
            : (value) => setState(() {
                tab = value.first;
                c.error = null;
              }),
      ),
      const SizedBox(height: 24),
      if (tab == 2)
        PublicConnectionView(controller: c)
      else ...[
        if (tab == 0) ...[
          const Card(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Column(
                children: [
                  Icon(Icons.qr_code_scanner, size: 64),
                  SizedBox(height: 16),
                  Text('扫描电脑二维码'),
                  SizedBox(height: 12),
                  Text(
                    '在电脑「设置 → 手机连接」开启访问，\n扫描二维码即可自动配置并绑定。',
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          ActionButton('扫一扫，连接电脑', onPressed: c.busy ? null : scan),
        ] else ...[
          input('电脑地址，例如 192.168.1.8:47832', endpoint, enabled: !c.busy),
          input('电脑显示的 10 位配对码', code, maxLength: 10, enabled: !c.busy),
          ActionButton(
            c.busy ? '正在连接…' : '绑定电脑',
            onPressed: c.busy
                ? null
                : () => c.pairedLan(endpoint.text, code.text, name.text),
          ),
        ],
        const SizedBox(height: 16),
        input('手机名称', name, maxLength: 60, enabled: !c.busy),
        ErrorNotice(c.error),
        const Text(
          '手机和电脑需要连接同一局域网。二维码 5 分钟内有效，使用一次即失效。也可以切换到手动配置，输入电脑地址和配对码。',
          style: TextStyle(fontSize: 12),
        ),
      ],
    ],
  );
}

class ScannerPage extends StatefulWidget {
  const ScannerPage({super.key});
  @override
  State<ScannerPage> createState() => _ScannerPageState();
}

class _ScannerPageState extends State<ScannerPage> {
  final scanner = MobileScannerController(formats: [BarcodeFormat.qrCode]);
  bool returned = false;
  @override
  void dispose() {
    scanner.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('扫描电脑配对二维码')),
    body: MobileScanner(
      controller: scanner,
      onDetect: (capture) {
        final value = capture.barcodes.firstOrNull?.rawValue;
        if (value == null || returned) return;
        returned = true;
        Navigator.pop(context, value);
      },
      errorBuilder: (_, error) =>
          Center(child: Text('无法使用相机：${error.errorCode.name}\n请在系统设置中允许相机权限')),
    ),
  );
}
