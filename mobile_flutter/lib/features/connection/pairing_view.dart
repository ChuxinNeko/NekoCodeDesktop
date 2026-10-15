import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
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
    final text = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) => const ScannerPage(),
        fullscreenDialog: true,
      ),
    );
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
  Widget build(BuildContext context) {
    final mx = context.mx;
    final media = MediaQuery.of(context);
    return Material(
      color: mx.surface,
      child: ListView(
        padding: EdgeInsets.fromLTRB(
          NekoGap.page,
          media.padding.top + 36,
          NekoGap.page,
          media.padding.bottom + media.viewInsets.bottom + 32,
        ),
        children: [
          const _Hero(),
          const SizedBox(height: 28),
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: MiuixTabRowWithContour(
                tabs: const ['扫码配对', '手动配置', '公网连接'],
                selectedTabIndex: tab,
                maxWidth: 420,
                onTabSelected: (value) {
                  if (c.busy) return;
                  setState(() {
                    tab = value;
                    c.error = null;
                  });
                },
              ),
            ),
          ),
          const SizedBox(height: 20),
          if (tab == 2)
            PublicConnectionView(controller: c)
          else ...[
            if (tab == 0) ..._scanTab(context) else ..._manualTab(context),
            ErrorNotice(
              c.error,
              margin: const EdgeInsets.symmetric(vertical: 8),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: MiuixText(
                '手机和电脑需要连接同一局域网。二维码 5 分钟内有效，使用一次即失效。也可以切换到手动配置，输入电脑地址和配对码。',
                fontSize: 12.5,
                height: 1.5,
                color: mx.onBackgroundVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _card(Widget child) => MiuixCard(
    cornerRadius: NekoShape.card,
    child: Padding(padding: const EdgeInsets.all(12), child: child),
  );

  List<Widget> _scanTab(BuildContext context) {
    final mx = context.mx;
    Widget step(int n, String text) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Container(
            width: 24,
            height: 24,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: mx.primary.withValues(alpha: .12),
              shape: BoxShape.circle,
            ),
            child: MiuixText(
              '$n',
              fontSize: 13,
              fontWeight: FontWeight.w700,
              color: mx.primary,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(child: MiuixText(text, fontSize: 14.5)),
        ],
      ),
    );
    return [
      _card(
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 16, 8, 8),
          child: Column(
            children: [
              Container(
                width: 88,
                height: 88,
                decoration: ShapeDecoration(
                  color: mx.primary.withValues(alpha: .1),
                  shape: NekoShape.squircle(28),
                ),
                alignment: Alignment.center,
                child: MiuixIcon(
                  vector: MiuixIcons.os4.scan,
                  size: 48,
                  tint: mx.primary,
                ),
              ),
              const SizedBox(height: 18),
              const MiuixText(
                '扫描电脑二维码',
                fontSize: 19,
                fontWeight: FontWeight.w700,
              ),
              const SizedBox(height: 16),
              step(1, '在电脑打开 NekoCode「设置 → 手机连接」'),
              step(2, '开启访问并显示配对二维码'),
              step(3, '用手机扫描，自动完成配置与绑定'),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
      const SizedBox(height: 16),
      ActionButton(
        '扫一扫，连接电脑',
        icon: Icons.qr_code_scanner_rounded,
        isPrimary: true,
        expand: true,
        onPressed: c.busy ? null : scan,
      ),
      const SizedBox(height: 12),
      _nameCard(),
    ];
  }

  Widget _nameCard() => _card(
    Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: input('手机名称', name, maxLength: 60, enabled: !c.busy),
    ),
  );

  List<Widget> _manualTab(BuildContext context) => [
    _card(
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Column(
          children: [
            input(
              '电脑地址，例如 192.168.1.8:47832',
              endpoint,
              enabled: !c.busy,
              keyboard: TextInputType.url,
            ),
            input('电脑显示的 10 位配对码', code, maxLength: 10, enabled: !c.busy),
          ],
        ),
      ),
    ),
    const SizedBox(height: 12),
    _nameCard(),
    const SizedBox(height: 16),
    ActionButton(
      c.busy ? '正在连接…' : '绑定电脑',
      isPrimary: true,
      expand: true,
      onPressed: c.busy
          ? null
          : () => c.pairedLan(endpoint.text, code.text, name.text),
    ),
  ];
}

class _Hero extends StatelessWidget {
  const _Hero();
  @override
  Widget build(BuildContext context) {
    final mx = context.mx;
    return Column(
      children: [
        DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(88 * .22),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: context.isDark ? .5 : .14),
                blurRadius: 24,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: Image.asset('assets/images/logo.png', width: 88, height: 88),
        ),
        const SizedBox(height: 22),
        const MiuixText('NekoCode', fontSize: 32, fontWeight: FontWeight.w700),
        const SizedBox(height: 6),
        MiuixText(
          '连接桌面，继续你的任务',
          fontSize: 16,
          color: mx.onSurfaceVariantSummary,
        ),
      ],
    );
  }
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
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    return Material(
      color: Colors.black,
      child: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            controller: scanner,
            onDetect: (capture) {
              final value = capture.barcodes.firstOrNull?.rawValue;
              if (value == null || returned) return;
              returned = true;
              Navigator.pop(context, value);
            },
            errorBuilder: (_, error) => Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: MiuixText(
                  '无法使用相机：${error.errorCode.name}\n请在系统设置中允许相机权限',
                  color: Colors.white,
                  textAlign: TextAlign.center,
                  height: 1.5,
                ),
              ),
            ),
          ),
          const IgnorePointer(child: _ScanFrame()),
          Positioned(
            top: media.padding.top + 12,
            left: 16,
            child: MiuixGlassIconButton(
              onPressed: () => Navigator.pop(context),
              tooltip: '关闭',
              semanticLabel: '关闭',
              child: MiuixIcon(vector: MiuixIcons.os4.close, size: 22),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: media.padding.bottom + 56,
            child: const Center(
              child: MiuixText(
                '将电脑上的配对二维码放入框内',
                fontSize: 15,
                color: Colors.white,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ScanFrame extends StatelessWidget {
  const _ScanFrame();
  @override
  Widget build(BuildContext context) =>
      CustomPaint(painter: _ScanFramePainter());
}

class _ScanFramePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final side = size.shortestSide * .66;
    final rect = Rect.fromCenter(
      center: Offset(size.width / 2, size.height * .42),
      width: side,
      height: side,
    );
    final rrect = RRect.fromRectAndRadius(rect, const Radius.circular(28));
    final dim = Path()
      ..addRect(Offset.zero & size)
      ..addRRect(rrect)
      ..fillType = PathFillType.evenOdd;
    canvas.drawPath(dim, Paint()..color = const Color(0x99000000));
    final p = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4
      ..strokeCap = StrokeCap.round;
    const l = 36.0, r = 28.0;
    void corner(Offset a, int dx, int dy) {
      final path = Path()
        ..moveTo(a.dx, a.dy + dy * l)
        ..lineTo(a.dx, a.dy + dy * r)
        ..arcToPoint(
          Offset(a.dx + dx * r, a.dy),
          radius: const Radius.circular(r),
          clockwise: dx * dy > 0,
        )
        ..lineTo(a.dx + dx * l, a.dy);
      canvas.drawPath(path, p);
    }

    corner(rect.topLeft, 1, 1);
    corner(rect.topRight, -1, 1);
    corner(rect.bottomLeft, 1, -1);
    corner(rect.bottomRight, -1, -1);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
