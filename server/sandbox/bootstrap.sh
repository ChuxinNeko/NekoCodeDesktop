#!/bin/sh
# Shipped inside the application; executed only over the verified host SSH link.
set -eu
# NEKOCODE_PAYLOAD
fail() { echo "$*" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || fail 'Automatic sandbox deployment requires Linux.'
[ "$(id -u)" = 0 ] || fail 'Automatic sandbox deployment requires a root SSH account. Edit the SSH username or ask your administrator to deploy server/sandbox/setup.sh.'
command -v flock >/dev/null || fail 'Missing flock (util-linux); install it and retry.'
exec 8>/run/lock/nekocode-sandbox-deploy.lock
flock -w 1800 8 || fail 'Another sandbox deployment is still running. Retry later.'
marker=/opt/nekocode-sandbox/deployment-version
if { [ -f /opt/nekocode-sandbox/manual-ready ] || { [ -f "$marker" ] && [ "$(cat "$marker")" = "$NEKOCODE_VERSION" ]; }; } &&
   [ -x /opt/nekocode-sandbox/runtime/runsc ] &&
   [ -f /usr/local/libexec/nekocode-sandbox/control.py ] &&
   docker image inspect nekocode/desktop-sandbox:1 >/dev/null 2>&1; then
  exit 0
fi
[ -r /etc/os-release ] || fail 'Cannot identify Linux distribution.'
. /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:24.04|debian:12) ;;
  *) fail 'Automatic deployment supports Ubuntu 24.04 and Debian 12. Other systems require administrator setup.' ;;
esac
case "$(uname -m)" in x86_64|aarch64) ;; *) fail 'Sandbox requires x86_64 or arm64.' ;; esac
command -v systemctl >/dev/null && [ -d /run/systemd/system ] || fail 'A running systemd host is required.'
awk 'BEGIN {ok=0} /^MemAvailable:/ {ok=($2>=2097152)} END {exit !ok}' /proc/meminfo ||
  fail 'At least 2 GiB available RAM is required for deployment. Recommended host: 4 vCPU, 8 GB RAM, plus resources for existing workloads.'
[ "$(df -Pk /var/lib | awk 'END {print $4}')" -ge 8388608 ] || fail 'At least 8 GiB free disk is required in /var/lib; 20 GB free is recommended.'
kernel=$(uname -r | cut -d- -f1)
dpkg --compare-versions "$kernel" ge 5.6 || fail 'Linux kernel 5.6 or newer is required.'
echo NEKOCODE_STAGE:dependencies
packages=''
[ -s /etc/ssl/certs/ca-certificates.crt ] || packages=' ca-certificates'
for entry in 'python3:python3' 'iptables:iptables' 'ip6tables:iptables' 'bzip2:bzip2'; do
  cmd=${entry%%:*}; pkg=${entry#*:}
  command -v "$cmd" >/dev/null || packages="$packages $pkg"
done
new_docker=0
if ! command -v docker >/dev/null && ! command -v dockerd >/dev/null; then
  packages="$packages docker.io"; new_docker=1
fi
if [ -n "$packages" ]; then
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
  apt-get -o DPkg::Lock::Timeout=120 -o Acquire::http::Timeout=30 -o Acquire::Retries=2 update
  # Only distribution packages; never execute downloaded installation scripts.
  apt-get -o DPkg::Lock::Timeout=120 -o Acquire::http::Timeout=30 -o Acquire::Retries=2 install -y --no-install-recommends $packages
fi
if [ "$new_docker" = 1 ]; then systemctl enable --now docker; fi
docker info >/dev/null || fail 'Docker is unavailable. Start/fix the existing Docker service and retry.'
mkdir -p /opt
python3 - <<'PY'
import base64,json,os,pathlib,shutil,subprocess,tempfile
files=json.loads(base64.b64decode(os.environ['NEKOCODE_PAYLOAD']))
root=pathlib.Path(tempfile.mkdtemp(prefix='nekocode-deploy-',dir='/opt'))
try:
    for name,content in files.items():
        if pathlib.Path(name).name != name: raise ValueError('Invalid bundled filename')
        (root/name).write_text(content,encoding='utf-8')
    subprocess.run(['sh',str(root/'setup.sh')],check=True)
    marker=pathlib.Path('/opt/nekocode-sandbox/deployment-version')
    temporary=marker.with_suffix('.tmp')
    temporary.write_text(os.environ['NEKOCODE_VERSION'],encoding='ascii')
    temporary.replace(marker)
finally:
    shutil.rmtree(root)
PY
