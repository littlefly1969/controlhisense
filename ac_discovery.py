#!/usr/bin/env python3
import argparse
import concurrent.futures
import gzip
import ipaddress
import json
import socket
import subprocess
import time
import urllib.request
from dataclasses import dataclass, asdict
from typing import Iterable


DEFAULT_PORTS = [
    80,
    443,
    1024,
    1883,
    3000,
    5000,
    5555,
    6666,
    6667,
    6668,
    7000,
    8000,
    8080,
    8443,
    8883,
    8888,
    8899,
    9999,
    10000,
    10240,
]


@dataclass
class Host:
    ip: str
    mac: str | None
    vendor: str | None
    open_ports: list[int]
    http_title: str | None
    http_server: str | None
    classification: list[str]


def run(args: list[str], timeout: float = 5) -> str:
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=timeout)
    except Exception:
        return ""


def ping(ip: str) -> str | None:
    result = subprocess.run(
        ["ping", "-c", "1", "-W", "1", ip],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return ip if result.returncode == 0 else None


def scan_port(ip: str, port: int, timeout: float = 0.25) -> bool:
    sock = socket.socket()
    sock.settimeout(timeout)
    try:
        sock.connect((ip, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def ip_neigh() -> dict[str, str]:
    out = run(["ip", "neigh"])
    result: dict[str, str] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].startswith("192.") and "lladdr" in parts:
            result[parts[0]] = parts[parts.index("lladdr") + 1]
    return result


def vendor_lookup(mac: str | None) -> str | None:
    if not mac:
        return None
    try:
        with urllib.request.urlopen(f"https://api.macvendors.com/{mac}", timeout=2) as resp:
            text = resp.read().decode(errors="replace").strip()
            return text or None
    except Exception:
        return None


def read_http(ip: str, port: int) -> tuple[str | None, str | None]:
    if port not in (80, 8080, 8000):
        return None, None
    try:
        req = f"GET / HTTP/1.0\r\nHost: {ip}\r\nAccept-Encoding: gzip\r\n\r\n".encode()
        sock = socket.create_connection((ip, port), timeout=1.5)
        sock.sendall(req)
        data = sock.recv(4096)
        sock.close()
    except OSError:
        return None, None

    header, _, body = data.partition(b"\r\n\r\n")
    headers = header.decode(errors="replace")
    server = None
    for line in headers.splitlines():
        if line.lower().startswith("server:"):
            server = line.split(":", 1)[1].strip()
            break
    if "content-encoding: gzip" in headers.lower():
        try:
            body = gzip.decompress(body)
        except (OSError, EOFError):
            pass
    text = body.decode(errors="replace")
    title = None
    lower = text.lower()
    start = lower.find("<title>")
    end = lower.find("</title>")
    if start >= 0 and end > start:
        title = text[start + 7:end].strip()[:120]
    return title, server


def classify(host: Host) -> list[str]:
    labels = []
    ports = set(host.open_ports)
    vendor = (host.vendor or "").lower()
    title = (host.http_title or "").lower()
    server = (host.http_server or "").lower()
    if 8888 in ports or 8899 in ports or 1024 in ports:
        labels.append("possible-old-hisense-ayla")
    if 6668 in ports or "tuya" in vendor:
        labels.append("tuya-local-key-required")
    if "spwf01" in title or "spwf01" in server:
        labels.append("st-spwf01-module")
    if "mongoose" in server:
        labels.append("embedded-http")
    if not labels and ports:
        labels.append("network-device")
    return labels


def wifi_scan() -> list[dict[str, str]]:
    out = run(["nmcli", "-t", "-f", "SSID,BSSID,CHAN,SIGNAL,SECURITY", "dev", "wifi", "list", "--rescan", "yes"], timeout=12)
    networks = []
    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) >= 5:
            networks.append({
                "ssid": parts[0],
                "bssid": ":".join(parts[1:7]) if len(parts) > 7 else parts[1],
                "channel": parts[-3],
                "signal": parts[-2],
                "security": parts[-1],
            })
    return networks


def discover(network: str, ports: Iterable[int], include_vendors: bool) -> dict:
    ips = [str(ip) for ip in ipaddress.ip_network(network).hosts()]
    with concurrent.futures.ThreadPoolExecutor(max_workers=100) as pool:
        alive = sorted([ip for ip in pool.map(ping, ips) if ip], key=lambda x: tuple(map(int, x.split("."))))

    neigh = ip_neigh()

    def build(ip: str) -> Host:
        open_ports = [port for port in ports if scan_port(ip, port)]
        mac = neigh.get(ip)
        vendor = vendor_lookup(mac) if include_vendors else None
        title = server = None
        for port in (80, 8080, 8000):
            if port in open_ports:
                title, server = read_http(ip, port)
                if title or server:
                    break
        host = Host(ip, mac, vendor, open_ports, title, server, [])
        host.classification = classify(host)
        return host

    with concurrent.futures.ThreadPoolExecutor(max_workers=40) as pool:
        hosts = [host for host in pool.map(build, alive) if host.open_ports]

    return {
        "timestamp": int(time.time()),
        "network": network,
        "hosts": [asdict(host) for host in hosts],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--network", default="192.168.1.0/24")
    parser.add_argument("--ports", default=",".join(map(str, DEFAULT_PORTS)))
    parser.add_argument("--json", default="")
    parser.add_argument("--wifi", action="store_true")
    parser.add_argument("--no-vendors", action="store_true")
    args = parser.parse_args()

    ports = [int(port.strip()) for port in args.ports.split(",") if port.strip()]
    report = discover(args.network, ports, include_vendors=not args.no_vendors)
    if args.wifi:
        report["wifi"] = wifi_scan()

    text = json.dumps(report, indent=2, sort_keys=True)
    print(text)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
