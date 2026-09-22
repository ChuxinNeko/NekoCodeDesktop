# NekoCode 公共后端

ElysiaJS + MongoDB。实现 NekoCode 账号（注册、邮箱验证码校验、登录、令牌刷新、密码重置），
以及**同账号设备发现 + 两条 WebSocket 端到端密文中继**：登录同一账号的桌面端和手机端通过
服务端中转加密的任务请求/响应，与局域网配对是两套完全独立的连接模式。

这是一个**独立包**，不在根 `package.json` 的 workspaces 里 —— 它的依赖（elysia / mongodb /
nodemailer）不应该被打进 Electron 桌面端。

```
cd server
bun install
cp .env.example .env    # 填好再启动
bun run dev
```

## 环境变量

见 `.env.example`。`.env` 已在 `.gitignore` 里，不要提交真实凭据。

`JWT_SECRET` 用 `openssl rand -base64 48` 生成。它同时用于签发 access token 和对验证码做
HMAC —— **更换它会让所有人退出登录，并作废所有未使用的验证码**。

### 邮件服务器证书

`mail.nekofun.top` 目前用的是**自签名证书**（已实测）。两个选择：

1. 给它签一张真证书（BillionMail 支持 Let's Encrypt），然后保持
   `SMTP_ALLOW_SELF_SIGNED=false`。
2. 暂时设 `SMTP_ALLOW_SELF_SIGNED=true`。连接仍然加密，但不再验证对端身份 —— 如果 API
   服务器和邮件服务器不在同一台机器上，SMTP 密码会以「加密但未认证」的方式过网络。同机部署
   时风险很低。

推荐 1。

## 接口

所有错误统一为 `{ "error": { "code": "...", "message": "..." } }`，`code` 供客户端分支，
`message` 供展示。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查 |
| POST | `/auth/register` | `{ email, password }` → `{ ok, next: "verify" }`，邮箱已注册则 `409 email_taken` |
| POST | `/auth/verify` | `{ email, code }` → 令牌对 + user |
| POST | `/auth/resend` | `{ email }` → `{ ok }` |
| POST | `/auth/forgot` | `{ email }` → `{ ok }`，已验证账号则发重置验证码 |
| POST | `/auth/reset` | `{ email, code, newPassword }` → `{ ok }`，成功会吊销全部 refresh session |
| POST | `/auth/login` | `{ email, password }` → 令牌对 + user |
| POST | `/auth/refresh` | `{ refreshToken }` → 新令牌对 |
| POST | `/auth/logout` | `{ refreshToken }` → 204 |
| POST | `/auth/logout-all` | Bearer → 204，踢掉全部设备 |
| GET | `/auth/me` | Bearer → `{ id, email, createdAt }` |
| GET | `/relay/devices` | Bearer → `{ devices }`，本账号设备 + 在线状态 |
| DELETE | `/relay/devices/:id` | Bearer → 204，幂等注销设备并断开其在线 socket |
| WS | `/relay/desktop` | 桌面端常连，注册设备并接受同账号手机连接 |
| WS | `/relay/mobile` | 手机端连接指定在线桌面，双向密文帧转发 |

错误码：`invalid_request` `email_taken` `invalid_credentials` `email_unverified`
`invalid_code` `code_expired` `too_many_requests` `unauthorized` `account_locked`
`server_error`。

### 注册流程

```
POST /auth/register  ─→  邮件发出 6 位验证码
POST /auth/verify    ─→  accessToken + refreshToken（验证完直接登录，不用再 login）
```

登录时如果邮箱还没验证，`/auth/login` 返回 `403 email_unverified` **并重新发一封验证码**，
客户端直接跳到验证码界面即可。

### 密码重置流程

```
POST /auth/forgot  ─→  若邮箱属于已验证账号，邮件发出 6 位重置验证码
POST /auth/reset   ─→  { ok }，新密码生效
```

`/auth/forgot` 对未知邮箱、未验证邮箱和已验证邮箱**返回完全相同的 `{ ok }`** —— 不泄露账号
是否存在，只是后一种情况真的发信。重置码和注册码复用 `verifications` 集合但 `purpose` 不同，
互不通用：拿重置码去 `/auth/verify`、拿注册码去 `/auth/reset` 都是 `code_expired` 且不消耗验证码。

`/auth/reset` 成功后会 `revokeAllForUser` 删除该账号全部 refresh session —— 所有设备需要重新
登录。已经签发的 access JWT 是无状态的，最长仍可用到自然过期（默认 15 分钟）。成功后**不**
自动登录，客户端应回到登录页让用户用新密码登录。

## 公网中继

公网 relay 和局域网配对是**完全独立的可选模式**：不共享 pairing/token，手机走
`/relay/mobile`、桌面走 `/relay/desktop`，都只需要账号 access JWT。不做 P2P 打洞——消息
是小体积 JSON，打洞收益小而仍需中继兜底。

### 协议（protocol 1）

- 桌面 hello：`{type:"hello", protocol:1, accessToken, device:{id,name,publicKey}}` →
  `{type:"ready"}`；同设备重连关闭旧 socket（4001）并先断开其挂着的手机（4404）。
- 手机 hello：`{type:"hello", protocol:1, accessToken, desktopId, peer:{id,publicKey}}` →
  `{type:"ready", connectionId, desktop}`，同时桌面收到 `{type:"peer", connectionId, peer}`。
- 帧：手机 `{type:"frame", payload}` → 桌面收到 `{type:"frame", connectionId, payload}`；
  桌面 `{type:"frame", connectionId, payload}` → 手机收到 `{type:"frame", payload}`。
  payload 是 `{version:1, iv, data}` 的 AES-GCM 密文，服务端只做形状/尺寸校验并**原样转发**，
  不 base64 解码 `data`、不解析明文。
- `ping`/`pong`；access token 到期时服务端发 `unauthorized` 并关 4401，客户端刷新后重连。
- `DELETE /relay/devices/:id` 注销设备：删库、踢在线 socket（desktop 4002、挂着的 mobile
  `desktop_offline` + 4404），幂等，不泄露设备是否存在。

### 设备与密钥

- `devices` 集合持久化 `{_id, userId, name, publicKey, createdAt, lastSeenAt}`；
  `online` 状态来自**单进程内存映射**（多实例部署需要 sticky/共享 presence，见「还没做」）。
- device id = 公钥原始字节（65 字节 `0x04` 前缀未压缩 P-256 点）的 SHA-256，服务端校验
  id 与公钥一致，防止冒名。
- 端到端加密在客户端做：P-256 ECDH → AES-256-GCM，AAD 绑定
  `connectionId + desktopId + peerId + direction`（两个方向各自独立）；明文上限 1MiB。

### 威胁模型

服务端正常运行时**只看到密文**，但它知道：账号归属、设备 id 与公钥、在线状态、连接时序、
消息大小。由于设备公钥由服务端分发，**主动恶意的服务端可以替换公钥发起中间人攻击**——
这是用户已知悉并接受的产品取舍，换取同账号自动发现、免配对。写对外安全说明时照此表述，
不要声称「服务端绝对无法解密」。

## 几个刻意的设计

**注册会明确告知邮箱已被占用。** `/auth/register` 对已验证的邮箱返回 `409 email_taken`，
客户端据此提示「这个邮箱已经注册过了，请直接登录」并跳回登录表单。

这是一个**有意识的取舍**：它意味着任何人都可以拿一个邮箱来问「这个地址在 NekoCode 注册过
吗」，属于账号枚举。换来的是注册表单能直接说清问题，而不是把已有账号的用户送进验证码界面去
等一封永远不会来的信。

注意范围：只有**已验证**的邮箱算被占用。未验证的账号谁都没证明拥有过，重复注册等于重发验证码
并覆盖密码。

`/auth/login` 对不存在的账号仍然会跑一次 Argon2，让失败耗时一致。既然注册已经泄露了同样的
事实，这不再是枚举防护 —— 留着是因为它让每次猜测都付出一次完整的 Argon2 代价。

**验证码不落库。** 存的是 `HMAC(secret, email:code)`。6 位数字只有一百万种可能，裸 SHA-256
的彩虹表一秒就能建好；掺进服务端密钥之后，拿到数据库也换不出可用的码。邮箱也参与 HMAC，所以
发给 A 的码不能拿去验 B。

**刷新令牌轮换。** access token 是短期 JWT（默认 15 分钟，无状态、不查库）；refresh token 是
不透明随机串，只以哈希形式存在于 `sessions` 集合，每次使用即作废并换新。被盗的 refresh token
因此是有界问题：小偷和机主不能同时用，输掉竞态的那个会被登出并察觉。

**限流分两层。** 验证码尝试次数（5 次）和重发冷却（60 秒）记在 MongoDB 的验证文档上，多实例
共享；按 IP 的外层限流在内存里，**只对单实例有效**。跑多副本之前要把
`src/rate-limit.ts` 换成 Mongo 或 Redis 实现。

**`x-forwarded-for` 只有在反代后面才可信**，所以默认只绑 `127.0.0.1`。直接暴露到公网的话这个
头可以随便伪造，IP 限流就废了 —— 绑回环是把这条约束变成结构上的，而不是只写在文档里。

nginx 那边（WS upgrade 头已被 `/relay/*` 使用，不是预留）：

```nginx
server {
    server_name codeapi.nekofun.top;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        # 这两行是 IP 限流的依据，必须由反代设置，不能透传客户端发来的值
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # /relay/desktop 与 /relay/mobile 需要 WebSocket 升级
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

域名只配在 nginx 和客户端里，后端不需要知道自己的公网地址 —— 它发出的东西没有一个包含指回
自身的链接。

## 数据

四个集合，索引在 `src/db.ts` 里连接时自动建好：

- `users.email` 唯一索引 —— 两个注册请求竞态时，靠它保证只有一个账号
- `verifications.expiresAt` / `sessions.expiresAt` TTL 索引 —— 真正让验证码和会话过期，
  而不只是标记为过期
- `devices` `{userId:1, lastSeenAt:-1}` —— 按账号列出设备并按最近在线排序；无 TTL，
  设备靠 `DELETE /relay/devices/:id` 或账号注销清理

## 测试

```
bun test        # 50 passed：验证码、密码、限流、邮箱校验、forgot/reset、relay hub、relay 路由
bun run typecheck
```

- `src/auth/routes.test.ts`：内存 fake collection 驱动真实 Elysia handler，覆盖
  forgot/reset 的安全行为。
- `src/relay/hub.test.ts`：Elysia-free 纯单测，真实 jose JWT + 真实 P-256 公钥指纹。
- `src/relay/routes.test.ts`：真实 `Elysia.listen` + 真实 WebSocket/fetch 的集成测试，
  覆盖 WS adapter 的 JSON 帧解析、设备列表、同账号连接、密文转发、踢出与注销；
  仍用 fake collection —— **auth/relay 都没有真实 MongoDB 集成测试**。

## 还没做

- **部署与真实联调**：Mongo 开认证、nginx TLS、进程守护、备份；relay 没连过真实
  Mongo/外网链路（本机 127.0.0.1 的 WS 集成测试通过不等于部署可用）。
- **多实例**：relay 在线映射和 IP 限流都是单进程内存，扩容要 sticky session /
  Redis pubsub / 共享 presence 与共享限流存储。
- **账号注销 / 数据删除**：法规与商店审核都需要。
