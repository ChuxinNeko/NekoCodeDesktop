# NekoCode gVisor 桌面沙盒

在目标服务器使用 gVisor systrap 运行独立 Linux 桌面，无需 KVM。NekoCode 经已验证主机密钥的 SSH 连接建立沙盒，再经该连接转发到沙盒内的 SSH 服务。桌面 VNC、AI 的 ssh 工具、SFTP 和交互终端共用同一个沙盒。

## 部署

需要 Linux 5.6+、x86_64/arm64、Python 3.11+、Docker Engine（iptables 后端）、iptables/ip6tables、systemd 和 root SSH 账号。Docker 使用其他防火墙后端时部署会失败，不会降低隔离要求。

在 NekoCode「设置 → SSH」选择「隔离沙盒」并保存，应用会通过已校验宿主密钥的 SSH 自动上传随应用打包的安装文件并部署；首次连接、测试连接也会检查并补装。自动部署支持 Ubuntu 24.04 / Debian 12，需 root SSH、systemd 和公网下载能力。缺失的 Python、iptables、CA 证书及 Docker 会从发行版软件源安装；已有 Docker 只 reload，不 restart。设置和桌面连接面板显示阶段进度，失败后点击测试或重新连接重试，不会回退宿主桌面。

建议宿主机使用 **4 vCPU、8GB 内存、至少 20GB 可用磁盘、Ubuntu 24.04**，已有业务的资源需额外预留。部署前至少需要 2GiB 可用内存和 `/var/lib` 所在分区 8GiB 可用磁盘。每个并发沙盒占用上限 1 CPU / 1536MiB 内存，暂停不释放内存；推荐配置适合单个轻量桌面和浏览器，重型浏览器任务可能需要调整沙盒本身的资源限制。

同版本的成功部署通过内容摘要识别，重复连接会跳过安装；安装过程以宿主文件锁串行执行。应用更新改变安装文件后会重新部署，复用已下载且校验通过的 runtime 及 Docker 构建缓存。安装中断不会写入成功标记，重试会继续部署。桌面镜像构建会测速选择 Debian 官方、阿里云或清华镜像，同时检查 Debian 主仓库和安全更新仓库；apt 仍验证 Debian 签名。可用 `DEBIAN_MIRROR` 手工指定软件源。关闭应用或连接中断时，远端安装可能仍在运行；再次连接会等待部署锁。自动部署不替代手工维护：其他发行版可以将此目录复制到服务器，以 root 执行：

```sh
sh setup.sh
# 手动成功部署会写入 manual-ready 标记，后续由管理员维护，不自动升级。
# 如需替换 Debian 软件源：
# DEBIAN_MIRROR=mirrors.aliyun.com sh setup.sh
```

脚本下载固定版本的官方 gVisor，核验官方 SHA-512，注册独立的 `nekocode-runsc` systrap runtime 并 reload Docker，不修改默认 runtime、不重启已有容器。它只增加专用网桥和以该网桥为入口的防火墙规则，不清空现有规则。Docker 配置首次修改前保存为 `/etc/docker/daemon.json.before-nekocode`。

之后在 NekoCode「设置 → SSH」编辑服务器，选择「隔离沙盒」。新建配置默认选择沙盒；旧配置保留原模式，需显式切换。沙盒模式的连接测试会先检查并部署环境，再验证管理 SSH；实际连接沙盒时仍检查完整隔离条件。

## 使用与边界

- 每个已保存的服务器配置共享一个沙盒，多个聊天也共享它；这不是每聊天独立实例。使用不同服务器配置可以创建多个沙盒。
- 点击连接、AI 首次使用 ssh/远程桌面或打开终端时创建实例；断开桌面只关闭连接。暂停保留进程与内存，下次连接恢复（暂停不会释放内存）；重置永久删除文件，下次连接创建干净实例。
- 每个实例从创建起最多保留 4 小时。init 最长运行 4 小时，定时清理每 5 分钟删除过期实例；重新连接前也检查期限。重要文件应提前下载。文件只保存在内存中，崩溃、服务器重启、重置或到期都会丢失；不提供持久化存储。
- 默认工作目录 `/home/neko/workspace`。宿主的 remoteDir 不会挂载进沙盒。自定义沙盒目录需由用户在沙盒内部创建。
- 默认 1 CPU、1536MiB 内存、512 个宿主进程/线程、禁用 swap，使用 Docker cgroup 限制。系统 rootfs 只读，不挂载任何宿主目录；唯一显式文件挂载是固定的只读公网 DNS 配置。用户主目录为 768MiB 有界 tmpfs，/tmp 为 256MiB；这些内存同时计入总上限，避免沙盒写满宿主磁盘。
- 沙盒无 sudo；桌面、命令和 SFTP 均以 uid 1000 执行。管理用 SSH 私钥只保存在 NekoCode 内存中；沙盒仅保存公钥。沙盒 SSH 主机公钥通过已验证的宿主 SSH 获取，再用于校验内层握手。
- 唯一发布端口是宿主 `127.0.0.1` 上的随机 SSH 端口。VNC 只监听沙盒内部 loopback，没有公开 VNC、密码登录或 root SSH 登录。
- 允许访问公网。防火墙阻断宿主服务、私网、链路本地/云元数据地址、同桥沙盒访问和 IPv6 出站；DNS 使用公网解析器，并通过固定只读配置文件绕过 Docker 的 127.0.0.11 内嵌 DNS（该地址无法被 gVisor 的独立网络栈访问，见 [gVisor FAQ](https://gvisor.dev/docs/user_guide/faq/)）。没有域名白名单。若应用需要私网服务，应设计单独的受控代理，不要移除隔离规则。
- 网络服务会随 Docker 服务启动恢复规则；每次连接也会检查。外部管理员删除或改变规则属于宿主权限操作，需要维护系统保证规则持续存在。iptables 不可用时连接失败。
- 镜像包含 TigerVNC RandR、AT-SPI 与 Xfce，供现有分辨率设置和无障碍工具使用。

gVisor 是用户态内核隔离，不等同于 Firecracker microVM；宿主的 root/Docker 管理员仍然是可信管理面。本机其他 AI 本地工具保持其原有行为，本适配约束的是配置为沙盒的 SSH 环境。

## 停用

先在 NekoCode 重置并删除相关沙盒，再禁用 `nekocode-sandbox-gc.timer`。只有全部相关容器删除后才考虑删除专用网络或 runtime。不要整份恢复 Docker 配置备份覆盖部署后的其他配置变更；应只移除 `runtimes.nekocode-runsc` 后校验并 reload。
