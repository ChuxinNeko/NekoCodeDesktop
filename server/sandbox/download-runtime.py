"""Download the official archive with bounded parallelism, then verify SHA-512."""
import concurrent.futures
import hashlib
import os
import re
import sys
import urllib.request

release, architecture, target = sys.argv[1:]
if not re.fullmatch(r'\d{8}\.\d+', release) or architecture not in ['x86_64', 'aarch64']:
    raise ValueError('Invalid gVisor release or architecture')
base = f'https://storage.googleapis.com/gvisor/releases/release/{release}/{architecture}/gvisor.tar.bz2'
expected = urllib.request.urlopen(base + '.sha512', timeout=30).read().decode().split()[0].lower()
if not re.fullmatch(r'[a-f0-9]{128}', expected):
    raise ValueError('Invalid official checksum')
if os.path.isfile(target) and hashlib.file_digest(open(target, 'rb'), 'sha512').hexdigest() == expected:
    print('Official gVisor archive checksum verified (cached)')
    sys.exit(0)
size = int(urllib.request.urlopen(urllib.request.Request(base, method='HEAD'), timeout=30).headers['Content-Length'])
parts = 16
step = (size + parts - 1) // parts


def download(index):
    start, end = index * step, min(size - 1, (index + 1) * step - 1)
    request = urllib.request.Request(base, headers={'Range': f'bytes={start}-{end}'})
    with urllib.request.urlopen(request, timeout=120) as response:
        if response.status != 206:
            raise RuntimeError('Release server did not honor range request')
        data = response.read()
    if len(data) != end - start + 1:
        raise RuntimeError('Incomplete release download')
    return data


with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
    with open(target + '.partial', 'wb') as output:
        for data in pool.map(download, range(parts)):
            output.write(data)
if hashlib.file_digest(open(target + '.partial', 'rb'), 'sha512').hexdigest() != expected:
    raise RuntimeError('Official gVisor checksum mismatch')
os.replace(target + '.partial', target)
print('Official gVisor archive checksum verified')
