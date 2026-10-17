"""Trusted sandbox init: no host mounts or host services are required."""
import os
import signal
import subprocess
import time

os.makedirs('/run/sshd', mode=0o755, exist_ok=True)
os.makedirs('/run/neko', mode=0o755, exist_ok=True)
subprocess.run(['runuser', '-u', 'neko', '--', 'mkdir', '-p', '/home/neko/workspace'], check=True)
os.makedirs('/tmp/runtime-neko', mode=0o700, exist_ok=True)
os.chown('/tmp/runtime-neko', 1000, 1000)
subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', '/run/neko/ssh_host_ed25519_key'], check=True)
children = []
stopping = False


def stop(*_):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
children.append(subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', '/etc/ssh/sshd_config.neko']))
environment = dict(os.environ, DISPLAY=':1', DBUS_SESSION_BUS_ADDRESS='unix:path=/tmp/neko-session-bus', XDG_RUNTIME_DIR='/tmp/runtime-neko')
children.append(subprocess.Popen(['runuser', '-u', 'neko', '--', 'dbus-daemon', '--session', '--nofork', '--address=unix:path=/tmp/neko-session-bus'], env=environment))
children.append(subprocess.Popen(['runuser', '-u', 'neko', '--', '/opt/nekocode/session.sh'], env=environment))
deadline = time.monotonic() + 4 * 60 * 60
try:
    while not stopping and time.monotonic() < deadline:
        if any(child.poll() is not None for child in children):
            for child in children:
                if child.returncode is not None:
                    print(f'Sandbox service exited: {child.args[0]} ({child.returncode})', flush=True)
            for path in ['/tmp/vnc.log', '/tmp/xfce.log']:
                try:
                    with open(path) as log:
                        print(log.read()[-4096:], flush=True)
                except OSError:
                    pass
            break
        while True:
            dead = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if not dead:
                break
            child = next((p for p in children if p.pid == dead.si_pid), None)
            if child:
                child.poll()
            else:
                os.waitpid(dead.si_pid, os.WNOHANG)
        time.sleep(1)
finally:
    for child in children:
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
