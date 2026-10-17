"""Root-owned host control plane. Only fixed lifecycle operations are accepted.

No arbitrary host commands, image names, mounts, runtime flags or paths arrive from
the app/agent. Shells and SFTP use a separately authenticated SSH server in gVisor.
"""
import base64
import datetime
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from contextlib import contextmanager

from network import NETWORK, check as check_network

IMAGE = 'nekocode/desktop-sandbox:1'
RUNTIME = 'nekocode-runsc'
LABEL = 'dev.nekocode.sandbox'
TTL = 4 * 60 * 60
MEMORY = 1536 * 1024 * 1024
DNS_FILE = '/opt/nekocode-sandbox/resolv.conf'
DNS_BIND = DNS_FILE + ':/etc/resolv.conf:ro'
DNS_CONTENT = 'nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:2 attempts:2\n'
TMPFS = {'/run': 'rw,nosuid,nodev,size=32m,mode=0755', '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777',
         '/home/neko': 'rw,nosuid,nodev,size=768m,uid=1000,gid=1000,mode=0700'}


def run(args, timeout=60, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, **kwargs)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout or 'Sandbox command failed')[-4096:].strip())
    return result.stdout


def inspect(name):
    result = subprocess.run(['docker', 'container', 'inspect', name], capture_output=True, text=True, timeout=30)
    if result.returncode:
        if 'No such' in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout)[0]


def age(container):
    created = datetime.datetime.fromisoformat(container['Created'].replace('Z', '+00:00'))
    return (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds()


def owned(container, name):
    labels = container['Config'].get('Labels') or {}
    if labels.get(LABEL) != '1' or labels.get(LABEL + '.owner') != name:
        raise RuntimeError('Container name belongs to a different workload; refusing to modify it')


def validate(container, name):
    owned(container, name)
    config = container['HostConfig']
    mounts = container.get('Mounts') or []
    def safe_mount(m):
        if m.get('Type') == 'tmpfs':
            return m.get('Destination') in TMPFS
        return (m.get('Type') == 'bind' and m.get('Source') == DNS_FILE and
                m.get('Destination') == '/etc/resolv.conf' and m.get('RW') is False)
    if (config['Runtime'] != RUNTIME or config.get('Privileged') or config.get('Binds') != [DNS_BIND] or
            any(not safe_mount(m) for m in mounts) or
            not config.get('ReadonlyRootfs') or config.get('Tmpfs') != TMPFS or
            config.get('NetworkMode') != NETWORK or
            config.get('Memory') != MEMORY or config.get('MemorySwap') != MEMORY or
            config.get('NanoCpus') != 1_000_000_000 or config.get('PidsLimit') != 512 or
            not any(x.startswith('no-new-privileges') for x in config.get('SecurityOpt') or [])):
        raise RuntimeError('Sandbox configuration changed; reset it before connecting')
    bindings = config.get('PortBindings') or {}
    if set(bindings) != {'22/tcp'} or len(bindings['22/tcp']) != 1 or bindings['22/tcp'][0]['HostIp'] != '127.0.0.1':
        raise RuntimeError('Sandbox SSH port must be published only on loopback')


def prerequisites():
    if os.geteuid() != 0:
        raise RuntimeError('Sandbox control requires a root SSH account')
    with open('/etc/docker/daemon.json') as file:
        runtime = json.load(file).get('runtimes', {}).get(RUNTIME, {})
    if runtime.get('path') != '/opt/nekocode-sandbox/runtime/runsc' or runtime.get('runtimeArgs') != ['--platform=systrap']:
        raise RuntimeError('The dedicated systrap runtime is not configured')
    check_network()
    if os.path.islink(DNS_FILE) or os.stat(DNS_FILE).st_uid != 0 or os.stat(DNS_FILE).st_mode & 0o022:
        raise RuntimeError('Sandbox DNS configuration must be root-owned and read-only to other users')
    with open(DNS_FILE) as file:
        if file.read() != DNS_CONTENT:
            raise RuntimeError('Unexpected sandbox DNS configuration')
    image = json.loads(run(['docker', 'image', 'inspect', IMAGE]))[0]
    if image['Config'].get('Labels', {}).get('dev.nekocode.sandbox-image') != '1':
        raise RuntimeError('Desktop sandbox image is missing or invalid')
    return image['Id']


@contextmanager
def locked(name):
    os.makedirs('/run/lock/nekocode-sandbox', mode=0o700, exist_ok=True)
    with open('/run/lock/nekocode-sandbox/' + name, 'a') as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        yield


def manage(action, name, public_key=''):
    if not re.fullmatch(r'nekocode-[0-9a-f]{24}', name):
        raise RuntimeError('Invalid sandbox name')
    with locked(name):
        container = inspect(name)
        if container:
            owned(container, name)
        if action == 'stop':
            if container and container['State']['Running'] and not container['State'].get('Paused'):
                run(['docker', 'pause', name])
            return {}
        if action == 'reset':
            if container:
                run(['docker', 'rm', '--force', name])
            return {}
        image = prerequisites()
        fields = public_key.strip().split()
        if len(fields) < 2 or fields[0] != 'ssh-ed25519' or len(base64.b64decode(fields[1], validate=True)) != 51:
            raise RuntimeError('Invalid sandbox public key')
        public_key = ' '.join(fields[:2]) + '\n'
        if container and (age(container) >= TTL or not container['State']['Running']):
            run(['docker', 'rm', '--force', name])
            container = None
        if not container:
            run(['docker', 'create', '--name', name, '--runtime', RUNTIME,
                 '--label', LABEL + '=1', '--label', LABEL + '.owner=' + name,
                 '--network', NETWORK, '--dns', '1.1.1.1', '--dns', '8.8.8.8',
                 '--publish', '127.0.0.1::22', '--memory', str(MEMORY), '--memory-swap', str(MEMORY),
                 '--cpus', '1', '--pids-limit', '512', '--shm-size', '256m',
                 '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
                 '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
                 '--cap-add', 'SYS_CHROOT', '--cap-add', 'NET_BIND_SERVICE',
                 '--read-only',
                 '--volume', DNS_BIND,
                 *[arg for destination, options in TMPFS.items() for arg in ['--tmpfs', destination + ':' + options]],
                 '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2', image])
            container = inspect(name)
        validate(container, name)
        if container['State'].get('Paused'):
            run(['docker', 'unpause', name])
        if not container['State']['Running']:
            run(['docker', 'start', name])
        for _ in range(60):
            ready = subprocess.run(['docker', 'exec', name, 'test', '-f', '/tmp/neko-desktop-ready'], capture_output=True, timeout=10)
            if ready.returncode == 0:
                break
            current = inspect(name)
            if not current or not current['State']['Running']:
                logs = subprocess.run(['docker', 'logs', '--tail', '20', name], capture_output=True, text=True, timeout=15)
                raise RuntimeError('Sandbox desktop failed to start: ' + (logs.stdout + logs.stderr)[-4096:])
            time.sleep(0.5)
        else:
            raise RuntimeError('Sandbox desktop readiness timed out')
        run(['docker', 'exec', '--user', '0', '--interactive', name, 'python3', '-c',
             "import os,sys; p='/run/neko/authorized_keys'; f=p+'.tmp'; open(f,'w').write(sys.stdin.read()); os.chmod(f,0o644); os.replace(f,p)"], input=public_key)
        host_key = run(['docker', 'exec', '--user', '0', name, 'cat', '/run/neko/ssh_host_ed25519_key.pub']).split()[1]
        container = inspect(name)
        validate(container, name)
        ports = container['NetworkSettings']['Ports']['22/tcp']
        if len(ports) != 1 or ports[0]['HostIp'] != '127.0.0.1':
            raise RuntimeError('Unexpected sandbox SSH endpoint')
        return {'port': int(ports[0]['HostPort']), 'hostKey': host_key, 'containerId': container['Id']}


def gc():
    names = run(['docker', 'ps', '-a', '--filter', 'label=' + LABEL + '=1', '--format', '{{.Names}}']).splitlines()
    for name in names:
        if not re.fullmatch(r'nekocode-[0-9a-f]{24}', name):
            continue
        with locked(name):
            container = inspect(name)
            if container:
                owned(container, name)
                if age(container) >= TTL:
                    run(['docker', 'rm', '--force', name])


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise RuntimeError('Root privileges required')
        if sys.argv[1:] == ['gc']:
            gc()
        elif len(sys.argv) == 3 and sys.argv[1] in ['ensure', 'stop', 'reset']:
            print(json.dumps(manage(sys.argv[1], sys.argv[2], sys.stdin.read(16384))))
        else:
            raise RuntimeError('Expected ensure|stop|reset NAME, or gc')
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
