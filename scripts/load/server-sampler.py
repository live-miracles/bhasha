#!/usr/bin/env python3
"""Samples the LiveKit server host during a load test. Run it ON the server.

    python3 server-sampler.py <seconds> <out.csv>

Columns: t, host_cpu_pct, livekit_cpu_pct, proxy_cpu_pct, proxy_count, livekit_rss_mb, udp_in,
udp_out, udp_in_errors, udp_rcvbuf_errors, udp_sndbuf_errors, hottest_thread_pct,
threads_over_50, nic_tx_pps, nic_tx_mbps, nic_rx_pps.

CPU percentages are of ONE core, so 400 means all four cores of a 4 vCPU VM are busy.

The column to trust for "did the server actually send everything" is nic_tx_pps: a listener
receives about 50 audio packets/s, so N listeners should produce roughly 49 x N packets/s. The
kernel UDP counters (udp_*) only see sockets in the host's network namespace, so they are blind to
traffic that Docker NATs to a container; with LiveKit on the host network they do work.
"""
import re
import subprocess
import sys
import time
from pathlib import Path


def default_interface() -> str:
    out = subprocess.run(['ip', '-o', '-4', 'route', 'show', 'to', 'default'], capture_output=True, text=True).stdout.split()
    return out[out.index('dev') + 1] if 'dev' in out else 'eth0'


IFACE = default_interface()
CORES = __import__('os').cpu_count() or 1


def snmp_udp() -> dict:
    lines = Path('/proc/net/snmp').read_text().splitlines()
    for i, line in enumerate(lines):
        if line.startswith('Udp:') and 'InDatagrams' in line:
            return dict(zip(line.split()[1:], map(int, lines[i + 1].split()[1:])))
    return {}


def host_cpu(prev):
    fields = [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:]]
    idle, total = fields[3] + fields[4], sum(fields)
    if prev is None:
        return 0.0, (idle, total)
    d_idle, d_total = idle - prev[0], total - prev[1]
    return (100.0 * (1 - d_idle / d_total) * CORES if d_total else 0.0), (idle, total)


def nic() -> dict:
    base = Path(f'/sys/class/net/{IFACE}/statistics')
    try:
        return {k: int((base / k).read_text()) for k in ('tx_packets', 'tx_bytes', 'rx_packets')}
    except OSError:
        return {'tx_packets': 0, 'tx_bytes': 0, 'rx_packets': 0}


def livekit_threads():
    pid = subprocess.run('pgrep -f "^/livekit-server" | head -1', shell=True, capture_output=True, text=True).stdout.strip()
    if not pid:
        return 0.0, 0
    out = subprocess.run(['top', '-H', '-b', '-n', '2', '-d', '1', '-w', '200', '-p', pid], capture_output=True, text=True).stdout
    cpus = []
    for line in out.split('top - ')[-1].splitlines():
        p = line.split()
        if len(p) >= 12 and p[0].isdigit():
            cpus.append(float(p[8].replace(',', '.')))
    return (max(cpus) if cpus else 0.0), sum(1 for c in cpus if c >= 50)


def processes():
    out = subprocess.run(['top', '-b', '-n', '2', '-d', '1', '-w', '200'], capture_output=True, text=True).stdout
    live = proxy = rss = 0.0
    for line in out.split('top - ')[-1].splitlines():
        p = line.split()
        if len(p) >= 12 and p[0].isdigit():
            cpu = float(p[8].replace(',', '.'))
            if p[11].startswith('livekit-server'):
                live += cpu
                m = re.match(r'([\d.]+)([mg]?)', p[5])
                if m:
                    rss += float(m.group(1)) * (1024 if m.group(2) == 'g' else 1 if m.group(2) == 'm' else 1 / 1024)
            elif p[11].startswith('docker-proxy'):
                proxy += cpu
    n_proxy = int(subprocess.run('pgrep -c docker-proxy', shell=True, capture_output=True, text=True).stdout.strip() or 0)
    return live, proxy, n_proxy, rss


def main() -> None:
    seconds, out_path = int(sys.argv[1]), sys.argv[2]
    base_udp = snmp_udp()
    _, cpu_state = host_cpu(None)
    last_nic, last_t = nic(), time.time()
    end = time.time() + seconds
    with open(out_path, 'w') as f:
        f.write(
            't,host_cpu_pct,livekit_cpu_pct,proxy_cpu_pct,proxy_count,livekit_rss_mb,udp_in,udp_out,'
            'udp_in_errors,udp_rcvbuf_errors,udp_sndbuf_errors,hottest_thread_pct,threads_over_50,'
            'nic_tx_pps,nic_tx_mbps,nic_rx_pps\n'
        )
        t0 = time.time()
        while time.time() < end:
            live, proxy, n_proxy, rss = processes()
            host, cpu_state = host_cpu(cpu_state)
            hot, over50 = livekit_threads()
            now_nic, now = nic(), time.time()
            dt = max(now - last_t, 0.001)
            tx_pps = (now_nic['tx_packets'] - last_nic['tx_packets']) / dt
            tx_mbps = (now_nic['tx_bytes'] - last_nic['tx_bytes']) * 8 / dt / 1e6
            rx_pps = (now_nic['rx_packets'] - last_nic['rx_packets']) / dt
            last_nic, last_t = now_nic, now
            udp = snmp_udp()
            delta = lambda k: udp.get(k, 0) - base_udp.get(k, 0)
            f.write(
                f"{int(now - t0)},{host:.0f},{live:.0f},{proxy:.0f},{n_proxy},{rss:.0f},{delta('InDatagrams')},"
                f"{delta('OutDatagrams')},{delta('InErrors')},{delta('RcvbufErrors')},{delta('SndbufErrors')},"
                f"{hot:.0f},{over50},{tx_pps:.0f},{tx_mbps:.2f},{rx_pps:.0f}\n"
            )
            f.flush()
            time.sleep(3)


if __name__ == '__main__':
    main()
