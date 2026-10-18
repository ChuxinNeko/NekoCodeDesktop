# 注册和启用 NekoCode GitHub App

桌面端支持「浏览器授权」和「设备码授权」。公共服务负责 OAuth 回调、换取令牌和刷新令牌；
桌面端在本机加密保存账号凭据。应用的 Client Secret 和服务端加密密钥均只配置在公共服务器。

## 1. 注册公共应用

已注册的应用：**NekoCode Desktop**，所有者 `@moraxs`。

- 公开页面：<https://github.com/apps/nekocode-desktop>
- 设置页面：<https://github.com/settings/apps/nekocode-desktop>
- Client ID：`Iv23lilu31wfiP6FDRBT`
- App ID：`5366497`
- Slug：`nekocode-desktop`

以上标识可以公开；Client Secret 和私钥不可提交到仓库。应用已上传项目图标并启用 Device Flow；服务端密钥配置和真实账号授权验收尚未完成。

登录应用所有者的 GitHub 账号，或进入组织的 Settings，在 **Developer settings → GitHub Apps → New GitHub App** 注册：

- **GitHub App name**：例如 `NekoCode`（名称必须可用；可用其他名称）。
- **Homepage URL**：项目官网或 `https://github.com/ChuxinNeko/NekoCodeDesktop`。
- **Callback URL**：`https://codeapi.nekofun.top/github/auth/callback`。
- 勾选 **Expire user authorization tokens**，保留短期令牌和刷新令牌。
- 勾选 **Enable Device Flow**。这与浏览器授权可以同时启用。
- **Webhook → Active**：取消勾选；目前不需要 webhook。
- **Where can this GitHub App be installed?**：选择 **Any account**。
- 可不勾选 **Request user authorization (OAuth) during installation**：桌面端负责开始登录，安装仓库权限是单独一步。

建议仓库权限（与现有 PR、GitHub 工具对应）：

| Repository permission | 权限 | 用途 |
| --- | --- | --- |
| Metadata | Read-only（默认） | 仓库基本信息 |
| Contents | Read & write | 读取和修改仓库内容、提交与分支 |
| Pull requests | Read & write | 查看和创建 PR |
| Issues | Read-only | 读取 Issues、评论 |
| Checks | Read-only | PR 检查结果 |
| Commit statuses | Read-only | 提交状态 |
| Actions | Read-only | 工作流和日志 |

不需要用户邮箱权限；当前公共服务使用 OAuth Client Secret，不读取 GitHub App 私钥。GitHub 注册成功页提示安装前需要生成私钥；请由应用所有者在 Credentials 中生成并安全保管，勿提交到仓库。
Contents 使用读写权限以支持仓库内容修改及后续 Git HTTPS 推送。修改 `.github/workflows` 工作流文件还需单独申请 Workflows 写权限；本次授权接入不会修改 Git 全局凭据。

注册后记录：

1. **Client ID**（不是 App ID）。
2. **Client Secret**：点击 Generate a new client secret 生成，只填写到服务器环境变量。
3. **应用 slug**：应用公开地址 `https://github.com/apps/<slug>` 中的 `<slug>`。

官方参考：
- [注册 GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [浏览器和设备码授权](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [刷新用户访问令牌](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)

注册完成后，在应用设置的 **Display information → Upload a logo** 上传图标。可使用本仓库 `resources/icons/icon.png`；GitHub 接受小于 1 MB 的 PNG/JPG/GIF，推荐正方形图像。官方说明：[自定义应用徽章](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/creating-a-custom-badge-for-your-github-app)。

## 2. 配置公共服务器

在现有 `server/.env` 中填写（现有 MongoDB、JWT、邮件配置保持原值）：

```dotenv
GITHUB_APP_CLIENT_ID=Iv23lilu31wfiP6FDRBT
GITHUB_APP_CLIENT_SECRET=<服务器端 Client Secret>
GITHUB_APP_CALLBACK_URL=https://codeapi.nekofun.top/github/auth/callback
GITHUB_APP_SLUG=nekocode-desktop
GITHUB_AUTH_ENCRYPTION_KEY=<openssl rand -base64 48 的输出>
```

五项全部留空时，账号、邮件、中继服务照常工作，GitHub 授权接口返回明确的「尚未配置」错误。
只填写部分配置会阻止服务器启动，并指出缺少的配置项。

`GITHUB_AUTH_ENCRYPTION_KEY` 是独立 AES-GCM 加密密钥，不要复用 Client Secret 或 JWT_SECRET。
更换此密钥会使尚未领取的授权会话失效；已保存到桌面端的连接不受影响。

按现有部署方式更新并重启 `server`，反向代理将 `/github/auth/*` 转发至同一个 Bun 服务。
回调地址必须与 GitHub 注册内容完全一致，生产环境必须使用 HTTPS。
为回调路径关闭访问日志，或只记录 `$uri`（不含查询字符串）；不要记录请求体和 Authorization 头。
例如现有 nginx 的同一 `server` 块中可添加：

```nginx
location = /github/auth/callback {
    access_log off;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

其他路径沿用现有反向代理配置。应用默认绑定 loopback，并依赖受信代理设置的来源 IP 做限流。
本次新增 MongoDB `github_authorizations` 集合，启动时自动创建 `expiresAt` TTL 索引，无需改动现有集合。
凭据交接会话默认最长 15 分钟，访问令牌、刷新令牌、设备码和 PKCE verifier 在该集合中加密保存。
每次领取需要桌面独有的随机凭据，成功结果只领取一次；服务器不会持久保管已领取账号的刷新令牌。

## 3. 用户操作和验收

**浏览器方式**：设置 → GitHub → 浏览器授权 → 连接 GitHub → 在系统浏览器授权 → 返回 NekoCode。
如果浏览器没有自动打开，可以点击「打开授权页面」重试。

**设备码方式**：选择设备码授权 → 连接 GitHub → 复制验证码 → 打开授权页面 → 输入验证码并确认。
验证码也可在另一台设备的 `https://github.com/login/device` 输入。

首次授权后，点击 **管理仓库访问**，安装 GitHub App 并选择仓库。
私有仓库、组织仓库只有在应用已安装且当前用户也有权限时才可访问；组织可能要求管理员批准。
仅完成用户授权不等于已授权仓库。不要用「能读取公开仓库」代替私有仓库授权验收。

上线后分别验证：

1. 两种授权方式均显示正确 GitHub 用户名。
2. 取消授权、拒绝授权、验证码超时均可重新开始。
3. 重启桌面应用后登录仍在；令牌临近过期时自动续期。
4. 已选择仓库能读取 PR、创建 PR、查看检查；未选择仓库不可访问。
5. 修改仓库安装范围后生效；组织审批流程符合预期。
6. 在 GitHub 撤销授权后，访问失败或续期失败时可以重新连接。

断开连接/清除会删除本机保存的 OAuth/手动 Token，仍可能回退到机器上已有的 `gh auth` 登录。
它不会卸载 GitHub App 或撤销 GitHub 网站上的授权；彻底撤销请在 GitHub Settings → Applications 操作。
Linux 若密钥环不可用（`basic_text` 后端），不会保存新凭据，可配置系统密钥环或使用已有的 gh CLI 登录。
Windows/macOS 使用 Electron 的系统加密接口；原生密钥环和浏览器跳转仍需在各平台做真实账号验收。

## 4. API 与维护

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/github/auth/start` | `{method:"browser"\|"device",secret}` → 公共授权进度；secret 为桌面生成的 32 字节随机 base64url 值 |
| GET | `/github/auth/callback` | GitHub 浏览器回调；静态结果页，不把令牌放入 URL |
| POST | `/github/auth/poll` | `{id}` + `Authorization: Bearer <secret>`；完成时返回一次性凭据交接结果，仅主进程可见 |
| POST | `/github/auth/cancel` | `{id}` + 同一 Bearer；删除未领取会话 |
| POST | `/github/auth/refresh` | `{refreshToken}` → 轮换后的用户凭据；应用密钥由服务端添加 |

不要求用户先注册 NekoCode 账号。交接接口用独立随机会话凭据鉴权；刷新接口以 GitHub 刷新令牌鉴权。
这些端点处理敏感请求体，应由代理和运维日志策略排除请求体/凭据日志。
客户端只公开会话 URL、短验证码、进度和账号状态；GitHub 访问令牌与刷新令牌不进入 renderer/IPC。
桌面端续期并发合并，保存账号或清除账号后旧的续期结果不能覆盖新状态。

限流按当前服务实例的来源 IP 生效，多实例部署前需接入共享限流器；交接状态和一次性领取已经由 MongoDB 共享。
服务器在凭据交接成功但响应丢失时不会再次发放结果，用户需重新授权。
服务进程若恰好在向 GitHub 换码时退出，当前会话可能需要取消后重新开始；不要清理其他用户的数据恢复单次登录。

本地验证：

```bash
# 仓库根目录
bun run typecheck
bun test test/main/github-oauth.test.ts test/main/github-credential-store.test.ts
bun run build

# 公共服务
cd server
bun install --frozen-lockfile
bun run typecheck
bun run test
```

自动测试使用伪造的 GitHub 响应，不等于真实账号授权或线上部署已经成功。
