#!/usr/bin/env python3
import argparse
import json
import socket
from dataclasses import dataclass


VERSION_COMMAND = b"AT+XMV"
READ_STATUS_102_0 = bytes([
    0xF4, 0xF5, 0x00, 0x40, 0x0C, 0x00, 0x00, 0x01, 0x01, 0xFE, 0x01,
    0x00, 0x00, 0x66, 0x00, 0x00, 0x00, 0x01, 0xB3, 0xF4, 0xFB,
])


@dataclass
class ProbeResult:
    host: str
    port: int
    command: str
    response_hex: str
    response_text: str


def send(host: str, payload: bytes, source_ip: str | None, iface: str | None, timeout: float = 3) -> bytes:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    if iface:
        try:
            sock.setsockopt(socket.SOL_SOCKET, 25, (iface + "\0").encode())
        except OSError:
            pass
    if source_ip:
        sock.bind((source_ip, 0))
    sock.connect((host, 8888))
    sock.sendall(payload)
    data = sock.recv(512)
    sock.close()
    return data


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="192.168.1.10")
    parser.add_argument("--source-ip", default="")
    parser.add_argument("--iface", default="wlan0")
    parser.add_argument("command", choices=["version", "status"])
    args = parser.parse_args()

    payload = VERSION_COMMAND if args.command == "version" else READ_STATUS_102_0
    data = send(args.host, payload, args.source_ip or None, args.iface or None)
    result = ProbeResult(
        host=args.host,
        port=8888,
        command=args.command,
        response_hex=data.hex(),
        response_text=data.decode(errors="replace"),
    )
    print(json.dumps(result.__dict__, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
