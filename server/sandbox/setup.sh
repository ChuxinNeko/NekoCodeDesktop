#!/bin/sh
# Run as root on the target Linux server from a copy of this directory.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
command -v docker >/dev/null
command -v python3 >/dev/null
command -v iptables >/dev/null
command -v ip6tables >/dev/null
command -v systemctl >/dev/null
command -v dockerd >/dev/null
docker info >/dev/null
mkdir -p /opt/nekocode-sandbox /usr/local/libexec/nekocode-sandbox
exec 9>/run/lock/nekocode-sandbox-setup.lock
flock 9
release=20261012.0
echo NEKOCODE_STAGE:runtime
arch=$(uname -m)
runtime=/opt/nekocode-sandbox/runtime
if [ ! -x "$runtime/runsc" ] || ! "$runtime/runsc" --version | grep -q "release-$release"; then
  python3 ./download-runtime.py "$release" "$arch" /opt/nekocode-sandbox/gvisor.tar.bz2
  mkdir -p "$runtime"
  tar -xjf /opt/nekocode-sandbox/gvisor.tar.bz2 -C "$runtime" --no-same-owner
  chmod -R a+rX "$runtime"
fi
"$runtime/runsc" --version
install -m 755 control.py network.py /usr/local/libexec/nekocode-sandbox/
# Docker's embedded 127.0.0.11 DNS is outside gVisor's network stack. Supply
# one fixed public resolver file, mounted read-only; never use host networking.
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:2 attempts:2\n' > /opt/nekocode-sandbox/resolv.conf
chmod 644 /opt/nekocode-sandbox/resolv.conf
python3 - <<'PY'
import json,os,shutil,subprocess,tempfile
p='/etc/docker/daemon.json'
os.makedirs('/etc/docker',exist_ok=True)
c=json.load(open(p)) if os.path.exists(p) else {}
r={'path':'/opt/nekocode-sandbox/runtime/runsc','runtimeArgs':['--platform=systrap']}
current=c.setdefault('runtimes',{}).get('nekocode-runsc')
if current is not None and current != r:
 raise RuntimeError('Existing nekocode-runsc runtime differs; review before replacing')
c['runtimes']['nekocode-runsc']=r
with tempfile.NamedTemporaryFile('w',dir='/etc/docker',delete=False) as f:
 json.dump(c,f,indent=2);f.write('\n');tmp=f.name
try:
 subprocess.run(['dockerd','--validate','--config-file',tmp],check=True)
 if os.path.exists(p) and not os.path.exists(p+'.before-nekocode'):
  shutil.copy2(p,p+'.before-nekocode')
 os.chmod(tmp,0o600);os.replace(tmp,p)
finally:
 if os.path.exists(tmp):os.unlink(tmp)
PY
# Reload only; never restart existing business containers or change the default runtime.
systemctl reload docker
cat > /etc/systemd/system/nekocode-sandbox-network.service <<'UNIT'
[Unit]
Description=NekoCode sandbox network isolation
Requires=docker.service
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/libexec/nekocode-sandbox/network.py install
RemainAfterExit=yes

[Install]
WantedBy=docker.service
UNIT
cat > /etc/systemd/system/nekocode-sandbox-gc.service <<'UNIT'
[Unit]
Description=Remove expired NekoCode desktop sandboxes
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/libexec/nekocode-sandbox/control.py gc
UNIT
cat > /etc/systemd/system/nekocode-sandbox-gc.timer <<'UNIT'
[Unit]
Description=Clean expired NekoCode sandboxes every five minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable nekocode-sandbox-network.service nekocode-sandbox-gc.timer
echo NEKOCODE_STAGE:network
systemctl restart nekocode-sandbox-network.service
systemctl start nekocode-sandbox-gc.timer
echo NEKOCODE_STAGE:image
mirror=${DEBIAN_MIRROR:-$(python3 ./select-mirror.py)}
echo "Desktop package mirror: $mirror"
docker build --build-arg "DEBIAN_MIRROR=$mirror" -t nekocode/desktop-sandbox:1 .
python3 /usr/local/libexec/nekocode-sandbox/network.py check
# Administrator-managed deployments may use other compatible Linux distributions.
# They remain administrator-managed rather than receiving automatic app upgrades.
if [ -z "${NEKOCODE_VERSION:-}" ]; then
  touch /opt/nekocode-sandbox/manual-ready
fi
echo 'Ready. Select Isolated sandbox in NekoCode SSH settings.'
