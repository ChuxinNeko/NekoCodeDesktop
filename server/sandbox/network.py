"""Dedicated Docker bridge with public egress and no host/private network access.

Rules are installed atomically without flushing Docker or business firewall rules.
Every sandbox start verifies the hooks and chains; missing protection fails closed.
"""
import json
import shlex
import subprocess
import sys

NETWORK = 'nekocode-sandbox'
BRIDGE = 'neko-sbx0'
INPUT = 'NEKOCODE_SBX_IN'
FORWARD = 'NEKOCODE_SBX_FWD'
BLOCKED = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
           '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
           '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4']
IN_RULES = [['-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'RETURN'], ['-j', 'REJECT']]
FW_RULES = [IN_RULES[0]] + [['-d', net, '-j', 'REJECT'] for net in BLOCKED] + [['-o', BRIDGE, '-j', 'REJECT'], ['-j', 'RETURN']]


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=30, **kwargs).stdout


def network():
    data = json.loads(run(['docker', 'network', 'inspect', NETWORK]))[0]
    if (data['Driver'] != 'bridge' or data.get('EnableIPv6') or
            data['Options'].get('com.docker.network.bridge.name') != BRIDGE or
            data['Options'].get('com.docker.network.bridge.enable_icc') != 'false'):
        raise RuntimeError('Unexpected sandbox network configuration')


def check():
    network()
    for chain, rules in [(INPUT, IN_RULES), (FORWARD, FW_RULES)]:
        for rule in rules:
            run(['iptables', '-w', '5', '-C', chain] + rule)
        actual = [line for line in run(['iptables', '-w', '5', '-S', chain]).splitlines() if line.startswith('-A ')]
        if len(actual) != len(rules):
            raise RuntimeError('Unexpected sandbox firewall rules')
    run(['iptables', '-w', '5', '-C', 'INPUT', '-i', BRIDGE, '-j', INPUT])
    run(['iptables', '-w', '5', '-C', 'DOCKER-USER', '-i', BRIDGE, '-j', FORWARD])
    for chain in ['INPUT', 'FORWARD']:
        run(['ip6tables', '-w', '5', '-C', chain, '-i', BRIDGE, '-j', 'DROP'])


def install():
    found = subprocess.run(['docker', 'network', 'inspect', NETWORK], capture_output=True).returncode == 0
    if not found:
        run(['docker', 'network', 'create', '--driver', 'bridge',
             '--opt', f'com.docker.network.bridge.name={BRIDGE}',
             '--opt', 'com.docker.network.bridge.enable_icc=false', NETWORK])
    network()
    lines = ['*filter']
    for chain, rules in [(INPUT, IN_RULES), (FORWARD, FW_RULES)]:
        lines += [f':{chain} - [0:0]', f'-F {chain}']
        lines += [f'-A {chain} ' + shlex.join(rule) for rule in rules]
    lines += ['COMMIT', '']
    run(['iptables-restore', '--wait', '5', '--noflush'], input='\n'.join(lines))
    for chain, target in [('INPUT', INPUT), ('DOCKER-USER', FORWARD)]:
        args = ['iptables', '-w', '5', '-C', chain, '-i', BRIDGE, '-j', target]
        if subprocess.run(args, capture_output=True).returncode:
            run(['iptables', '-w', '5', '-I', chain, '1', '-i', BRIDGE, '-j', target])
    for chain in ['INPUT', 'FORWARD']:
        args = ['ip6tables', '-w', '5', '-C', chain, '-i', BRIDGE, '-j', 'DROP']
        if subprocess.run(args, capture_output=True).returncode:
            run(['ip6tables', '-w', '5', '-I', chain, '1', '-i', BRIDGE, '-j', 'DROP'])
    check()


if __name__ == '__main__':
    try:
        install() if sys.argv[1:] == ['install'] else check()
    except Exception as error:
        print(f'Sandbox network protection unavailable: {error}', file=sys.stderr)
        sys.exit(1)
