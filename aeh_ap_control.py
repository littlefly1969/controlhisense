#!/usr/bin/env python3
import argparse
import json
import socket
import subprocess
import time
from dataclasses import dataclass

from pyaehw4a1.commands import ReadCommand, UpdateCommand


DEFAULT_IFACE = "wlan0"
DEFAULT_AP_HOST = "192.168.1.10"
DEFAULT_AP_PASSWORD = "12345678"


@dataclass
class CommandResult:
    ssid: str | None
    command: str
    host: str
    source_ip: str | None
    response_hex: str
    response_text: str
    ok: bool


def run(args: list[str], timeout: int = 30) -> str:
    completed = subprocess.run(
        args,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    return completed.stdout.strip()


def current_ssid(iface: str) -> str | None:
    try:
        output = run(["nmcli", "-t", "-f", "ACTIVE,SSID,DEVICE", "dev", "wifi"], timeout=10)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    for line in output.splitlines():
        parts = line.split(":")
        if len(parts) >= 3 and parts[0] == "yes" and parts[-1] == iface:
            return ":".join(parts[1:-1]) or None
    return None


def wifi_ipv4(iface: str) -> str | None:
    try:
        output = run(["ip", "-4", "-o", "addr", "show", "dev", iface], timeout=5)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    for token in output.split():
        if "/" in token and token[0].isdigit():
            return token.split("/", 1)[0]
    return None


def connect_wifi(ssid: str, iface: str, password: str) -> None:
    try:
        run(["nmcli", "dev", "wifi", "connect", ssid, "password", password, "ifname", iface], timeout=25)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        # Some AEH modules complete DHCP after NetworkManager has already timed out.
        pass
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if current_ssid(iface) == ssid and wifi_ipv4(iface):
            return
        time.sleep(1)
    raise RuntimeError(f"non sono riuscito ad agganciare {ssid} su {iface}")


def send_packet(
    host: str,
    payload: bytes,
    source_ip: str | None,
    iface: str | None,
    timeout: float = 3,
) -> bytes:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    if iface:
        try:
            sock.setsockopt(socket.SOL_SOCKET, 25, (iface + "\0").encode())
        except OSError:
            pass
    if source_ip:
        sock.bind((source_ip, 0))
    try:
        sock.connect((host, 8888))
        sock.sendall(payload)
        return sock.recv(512)
    finally:
        sock.close()


def command_payload(command: str) -> bytes:
    if command == "version":
        return b"AT+XMV"
    if command in ReadCommand.__members__:
        return ReadCommand[command].value
    if command in UpdateCommand.__members__:
        return UpdateCommand[command].value
    raise ValueError(f"comando non supportato: {command}")


def available_commands() -> dict[str, list[str]]:
    return {
        "special": ["version"],
        "read": sorted(ReadCommand.__members__),
        "update": sorted(UpdateCommand.__members__),
    }


def execute(
    command: str,
    ssid: str | None,
    iface: str,
    password: str,
    host: str,
    source_ip: str | None,
) -> CommandResult:
    if ssid:
        connect_wifi(ssid, iface, password)
    source_ip = source_ip or wifi_ipv4(iface)
    payload = command_payload(command)
    data = send_packet(host, payload, source_ip, iface)
    text = data.decode(errors="replace")
    return CommandResult(
        ssid=ssid or current_ssid(iface),
        command=command,
        host=host,
        source_ip=source_ip,
        response_hex=data.hex(),
        response_text=text,
        ok=bool(data),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Controllo locale Hisense AEH-W4A1 in SoftAP")
    parser.add_argument("--iface", default=DEFAULT_IFACE)
    parser.add_argument("--host", default=DEFAULT_AP_HOST)
    parser.add_argument("--password", default=DEFAULT_AP_PASSWORD)
    parser.add_argument("--source-ip", default="")
    sub = parser.add_subparsers(dest="action", required=True)

    sub.add_parser("list-commands")

    cmd = sub.add_parser("cmd")
    cmd.add_argument("--ssid", default="")
    cmd.add_argument("command")

    args = parser.parse_args()
    if args.action == "list-commands":
        print(json.dumps(available_commands(), indent=2))
        return 0

    result = execute(
        command=args.command,
        ssid=args.ssid or None,
        iface=args.iface,
        password=args.password,
        host=args.host,
        source_ip=args.source_ip or None,
    )
    print(json.dumps(result.__dict__, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
