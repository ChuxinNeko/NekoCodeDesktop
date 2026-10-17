"""Choose a responsive Debian mirror. apt still verifies Debian's signed metadata."""
import concurrent.futures
import time
import urllib.request

MIRRORS = ('deb.debian.org', 'mirrors.aliyun.com', 'mirrors.tuna.tsinghua.edu.cn')


def probe(mirror):
    started = time.monotonic()
    try:
        for path in ('debian/dists/bookworm/InRelease', 'debian-security/dists/bookworm-security/InRelease'):
            request = urllib.request.Request(f'http://{mirror}/{path}', headers={'User-Agent': 'NekoCode-sandbox-setup'})
            with urllib.request.urlopen(request, timeout=6) as response:
                data = response.read(256 * 1024)
                if response.status != 200 or not data.startswith(b'-----BEGIN PGP SIGNED MESSAGE-----'):
                    return None
        return time.monotonic() - started, mirror
    except (OSError, ValueError):
        return None


if __name__ == '__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = [result for result in pool.map(probe, MIRRORS) if result is not None]
    if not results:
        raise RuntimeError('Cannot reach Debian package mirrors. Check public HTTP/DNS access and retry.')
    print(min(results)[1])
