import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_miuix/miuix.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../mobile_controller.dart';

class PublicConnectionView extends StatefulWidget {
  const PublicConnectionView({super.key, required this.controller});
  final MobileController controller;
  @override
  State<PublicConnectionView> createState() => _PublicConnectionViewState();
}

class _PublicConnectionViewState extends State<PublicConnectionView> {
  final email = TextEditingController(),
      password = TextEditingController(),
      confirm = TextEditingController(),
      code = TextEditingController();
  String step = 'signin';
  String? error, notice;
  bool busy = false;
  List<Json>? devices;
  DateTime? resendAfter;
  Timer? timer;
  MobileController get c => widget.controller;
  int get cooldown => resendAfter == null
      ? 0
      : (resendAfter!.difference(DateTime.now()).inSeconds + 1).clamp(0, 60);
  @override
  void initState() {
    super.initState();
    if (c.desktop.account.signedIn) unawaited(load());
    timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && resendAfter != null) setState(() {});
    });
  }

  @override
  void dispose() {
    timer?.cancel();
    email.dispose();
    password.dispose();
    confirm.dispose();
    code.dispose();
    super.dispose();
  }

  Future<void> run(Future<void> Function() fn) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await fn();
    } catch (e) {
      if (mounted) {
        setState(() {
          error = '$e';
          if (e is ApiError && e.code == 'email_unverified') {
            step = 'verify';
            error = null;
            notice = '这个邮箱还没验证，验证码已重新发送';
            resetCooldown();
          }
          if (e is ApiError && e.code == 'email_taken') step = 'signin';
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void resetCooldown() =>
      resendAfter = DateTime.now().add(const Duration(seconds: 60));
  Future<void> load() => run(() async {
    final value = await c.desktop.relay.devices();
    if (mounted) setState(() => devices = value);
  });
  void go(String value) => setState(() {
    step = value;
    error = null;
    notice = null;
  });
  Future<void> submit() => run(() async {
    final a = c.desktop.account;
    if (!RegExp(r'^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$')
        .hasMatch(email.text.trim())) {
      throw ApiError('请输入有效邮箱');
    }
    if (['signin', 'register', 'reset'].contains(step) &&
        password.text.length < 8) {
      throw ApiError('密码至少需要 8 位');
    }
    if (step == 'signin') await a.login(email.text, password.text);
    if (step == 'register') {
      await a.register(email.text, password.text);
      step = 'verify';
      code.clear();
      resetCooldown();
      notice = '验证码已发送到 ${email.text.trim()}';
      return;
    }
    if (step == 'verify') {
      if (!RegExp(r'^\d{6}$').hasMatch(code.text.trim())) {
        throw ApiError('请输入 6 位验证码');
      }
      await a.verify(email.text, code.text);
    }
    if (step == 'forgot') {
      await a.forgot(email.text);
      step = 'reset';
      code.clear();
      password.clear();
      confirm.clear();
      resetCooldown();
      notice = '如果该邮箱已注册，验证码已发送';
      return;
    }
    if (step == 'reset') {
      if (password.text != confirm.text) throw ApiError('两次输入的密码不一致');
      if (!RegExp(r'^\d{6}$').hasMatch(code.text.trim())) {
        throw ApiError('请输入 6 位验证码');
      }
      await a.reset(email.text, code.text, password.text);
      step = 'signin';
      code.clear();
      password.clear();
      confirm.clear();
      notice = '密码已重置，请使用新密码登录';
      return;
    }
    final value = await c.desktop.relay.devices();
    if (mounted) setState(() => devices = value);
  });
  Widget _card(List<Widget> children) => MiuixCard(
    cornerRadius: NekoShape.card,
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    ),
  );

  Widget _link(String label, VoidCallback? onPressed) => MiuixPressable(
    onPressed: onPressed,
    enabled: onPressed != null,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
        child: MiuixText(
        label,
        fontSize: 15,
        color: onPressed == null
            ? context.mx.onSurfaceVariantActions
            : context.mx.primary,
      ),
    ),
  );

  Widget _note(String text, {Color? color}) => Padding(
    padding: const EdgeInsets.fromLTRB(8, 12, 8, 0),
    child: MiuixText(
      text,
      fontSize: 12.5,
      height: 1.5,
      color: color ?? context.mx.onBackgroundVariant,
    ),
  );

  @override
  Widget build(BuildContext context) {
    final mx = context.mx;
    if (c.desktop.account.signedIn) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          MiuixCard(
            cornerRadius: NekoShape.card,
            child: MiuixBasicComponent(
              insideMargin: const EdgeInsets.all(16),
              startAction: Padding(
                padding: const EdgeInsets.only(right: 14),
                child: IconTile(icon: MiuixIcons.os4.contactsCircle),
              ),
              content: [
                const MiuixText('已登录', fontSize: 13),
                MiuixText(
                  c.desktop.account.email ?? '',
                  fontSize: 16,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
              endActions: [
                ActionButton(
                  busy ? '刷新中…' : '刷新',
                  compact: true,
                  onPressed: busy ? null : load,
                ),
              ],
            ),
          ),
          const MiuixSmallTitle(
            '选择要连接的电脑',
            insideMargin: EdgeInsets.fromLTRB(16, 20, 16, 8),
          ),
          if (devices == null) _note(busy ? '正在获取设备列表…' : '暂时无法获取设备列表'),
          if (devices?.isEmpty == true)
            _card([
              MiuixText(
                '还没有可连接的电脑。请先在电脑「设置 → 连接 → 连接至APP」里用同一个 NekoCode 账号登录公网连接。',
                fontSize: 14,
                height: 1.5,
                color: mx.onSurfaceVariantSummary,
              ),
            ]),
          if (devices?.isNotEmpty == true)
            MiuixCard(
              cornerRadius: NekoShape.card,
              child: Column(
                children: [
                  for (final d in devices!)
                    MiuixBasicComponent(
                      insideMargin: const EdgeInsets.all(16),
                      startAction: Padding(
                        padding: const EdgeInsets.only(right: 14),
                        child: IconTile(icon: MiuixIcons.os4.layers),
                      ),
                      content: [
                        MiuixText(
                          string(d['name']),
                          fontSize: 16,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        MiuixText(
                          '${d['online'] == true ? '在线' : '离线'} · 最近在线 ${d['lastSeenAt']}',
                          fontSize: 12.5,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          color: mx.onSurfaceVariantSummary,
                        ),
                      ],
                      endActions: [
                        ActionButton(
                          '连接',
                          compact: true,
                          isPrimary: true,
                          onPressed: busy || c.busy || d['online'] != true
                              ? null
                              : () => c.selectRelay(d),
                        ),
                      ],
                    ),
                ],
              ),
            ),
          ErrorNotice(error, margin: const EdgeInsets.only(top: 12)),
          _note('公网连接与局域网配对相互独立。消息端到端加密，但设备公钥由账号服务分发；服务器主动替换公钥仍可能发起中间人攻击。'),
          const SizedBox(height: 20),
          ActionButton(
            '退出登录',
            danger: true,
            expand: true,
            onPressed: busy || c.busy
                ? null
                : () async {
                    await c.logout();
                    if (mounted) setState(() => devices = null);
                  },
          ),
        ],
      );
    }
    final titles = {
      'signin': '登录 NekoCode',
      'register': '注册账号',
      'verify': '输入验证码',
      'forgot': '忘记密码',
      'reset': '重置密码',
    };
    final subtitles = {
      'signin': '登录后即可在任何网络下访问你的电脑',
      'register': '使用邮箱创建 NekoCode 账号',
      'verify': '输入发送到邮箱的 6 位验证码',
      'forgot': '输入注册邮箱，我们会发送验证码',
      'reset': '输入验证码并设置新密码',
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 4, 8, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              MiuixText(
                titles[step]!,
                fontSize: 22,
                fontWeight: NekoWeight.title,
              ),
              const SizedBox(height: 4),
              MiuixText(
                subtitles[step]!,
                fontSize: 14,
                color: mx.onSurfaceVariantSummary,
              ),
            ],
          ),
        ),
        _card([
          input(
            '邮箱',
            email,
            keyboard: TextInputType.emailAddress,
            enabled: !busy,
          ),
          if (['verify', 'reset'].contains(step))
            input(
              '6 位验证码',
              code,
              keyboard: TextInputType.number,
              maxLength: 6,
              enabled: !busy,
            ),
          if (['signin', 'register', 'reset'].contains(step))
            input(
              step == 'reset' ? '新密码（至少 8 位）' : '密码（至少 8 位）',
              password,
              secret: true,
              enabled: !busy,
            ),
          if (step == 'reset' || step == 'register')
            input('确认密码', confirm, secret: true, enabled: !busy),
        ]),
        const SizedBox(height: 16),
        ActionButton(
          busy
              ? '处理中…'
              : step == 'verify'
              ? '验证并登录'
              : titles[step]!,
          isPrimary: true,
          expand: true,
          onPressed: busy
              ? null
              : () {
                  if (step == 'register' && password.text != confirm.text) {
                    setState(() => error = '两次输入的密码不一致');
                    return;
                  }
                  unawaited(submit());
                },
        ),
        if (notice != null) _note(notice!, color: mx.primary),
        ErrorNotice(error, margin: const EdgeInsets.only(top: 12)),
        const SizedBox(height: 8),
        if (step == 'verify' || step == 'reset')
          Center(
            child: _link(
              cooldown > 0 ? '$cooldown 秒后可重发' : '重新发送验证码',
              busy || cooldown > 0
                  ? null
                  : () => run(() async {
                      if (step == 'verify') {
                        await c.desktop.account.resend(email.text);
                      } else {
                        await c.desktop.account.forgot(email.text);
                      }
                      resetCooldown();
                      notice = '验证码已重新发送';
                    }),
            ),
          ),
        if (step == 'signin')
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              _link('注册账号', busy ? null : () => go('register')),
              _link('忘记密码？', busy ? null : () => go('forgot')),
            ],
          ),
        if (step != 'signin')
          Center(child: _link('返回登录', busy ? null : () => go('signin'))),
        if (step == 'verify')
          _note('验证码 10 分钟内有效。没收到？请检查垃圾邮件，或确认邮箱地址。验证码错误 5 次后需要重新获取。'),
      ],
    );
  }
}
