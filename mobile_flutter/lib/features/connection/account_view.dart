import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/protocol.dart';
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
  @override
  Widget build(BuildContext context) {
    if (c.desktop.account.signedIn) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('已登录\n${c.desktop.account.email}'),
          const SizedBox(height: 12),
          ActionButton(busy ? '刷新中…' : '刷新', onPressed: busy ? null : load),
          const SizedBox(height: 20),
          const Text('选择要连接的电脑'),
          if (devices == null) Text(busy ? '正在获取设备列表…' : '暂时无法获取设备列表'),
          if (devices?.isEmpty == true)
            const Text(
              '还没有可连接的电脑。请先在电脑「设置 → 连接 → 连接至APP」里用同一个 NekoCode 账号登录公网连接。',
            ),
          for (final d in devices ?? <Json>[])
            Card(
              child: ListTile(
                leading: Icon(
                  Icons.circle,
                  size: 12,
                  color: d['online'] == true ? Colors.green : Colors.grey,
                ),
                title: Text(string(d['name'])),
                subtitle: Text(
                  '${d['online'] == true ? '在线' : '离线'} · 最近在线 ${d['lastSeenAt']}',
                ),
                trailing: ActionButton(
                  '连接',
                  onPressed: busy || c.busy || d['online'] != true
                      ? null
                      : () => c.selectRelay(d),
                ),
              ),
            ),
          ErrorNotice(error),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 16),
            child: Text(
              '公网连接与局域网配对相互独立。消息端到端加密，但设备公钥由账号服务分发；服务器主动替换公钥仍可能发起中间人攻击。',
              style: TextStyle(fontSize: 12),
            ),
          ),
          ActionButton(
            '退出登录',
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(titles[step]!, style: Theme.of(context).textTheme.titleLarge),
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
        const SizedBox(height: 12),
        ActionButton(
          busy
              ? '处理中…'
              : step == 'verify'
              ? '验证并登录'
              : titles[step]!,
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
        if (notice != null)
          Padding(padding: const EdgeInsets.all(8), child: Text(notice!)),
        ErrorNotice(error),
        if (step == 'verify' || step == 'reset')
          TextButton(
            onPressed: busy || cooldown > 0
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
            child: Text(cooldown > 0 ? '$cooldown 秒后可重发' : '重新发送验证码'),
          ),
        if (step == 'signin')
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            children: [
              TextButton(
                onPressed: busy ? null : () => go('register'),
                child: const Text('注册账号'),
              ),
              TextButton(
                onPressed: busy ? null : () => go('forgot'),
                child: const Text('忘记密码？'),
              ),
            ],
          ),
        if (step != 'signin')
          TextButton(
            onPressed: busy ? null : () => go('signin'),
            child: const Text('返回登录'),
          ),
        if (step == 'verify')
          const Text('验证码 10 分钟内有效。没收到？请检查垃圾邮件，或确认邮箱地址。验证码错误 5 次后需要重新获取。'),
      ],
    );
  }
}
