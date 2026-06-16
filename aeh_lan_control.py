#!/usr/bin/env python3
import argparse
import json
import socket
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

from pyaehw4a1.commands import ReadCommand, UpdateCommand
from pyaehw4a1.responses import DataPacket, ResponsePacket

from app_config import configured_devices


PORT = 8888
DEFAULT_TIMEOUT = 6.0
DEFAULT_RETRIES = 3
RETRY_PAUSE = 6.0
DEVICE_PAUSE = 1.5


# --- Modello ventola: UNICA fonte di verita' --------------------------------
# Stato di verifica (giugno 2026, sonda su modulo spento + semantica libreria):
#   - `air_byte` e' il byte 16 del pacchetto update inviato al modulo. I valori
#     nativi della libreria pyaehw4a1 sono auto=1, mute=3, low=5, med=7, max=9
#     (verificati). speed_2 (6) e speed_4 (8) sono SINTETIZZATI riempiendo i
#     buchi fra le velocita' native: la loro esistenza come velocita' fisiche
#     distinte NON e' ancora confermata sul campo.
#   - `wind_status` e' il valore atteso in lettura (status_102_0) e risulta
#     = air_byte - 1. Confermato solo per auto (comando 1 -> letto 0); per gli
#     altri e' IPOTESI coerente, da verificare con l'unita' ACCESA: da spenta il
#     modulo riporta sempre wind_status 0, quindi non e' calibrabile da spento.
#   - "Silenzioso" e' mappato su wind_status 2, ma nel protocollo esiste anche un
#     bit `mute` separato (offset 166): da verificare quale dei due conta davvero.
@dataclass(frozen=True)
class FanSpeed:
    command: str       # nome comando esposto da UI/API
    label: str         # etichetta mostrata
    air_byte: int      # byte 16 inviato nel pacchetto update
    wind_status: int   # valore atteso in lettura (status_102_0)
    native: str | None = None  # UpdateCommand nativo, se esiste; altrimenti sintetizzato


FAN_SPEEDS: list[FanSpeed] = [
    FanSpeed("speed_auto", "Auto",       1, 0, native="speed_auto"),
    FanSpeed("speed_1",    "1",          5, 4, native="speed_low"),
    FanSpeed("speed_2",    "2",          6, 5),
    FanSpeed("speed_3",    "3",          7, 6, native="speed_med"),
    FanSpeed("speed_4",    "4",          8, 7),
    FanSpeed("speed_5",    "5",          9, 8, native="speed_max"),
    FanSpeed("speed_mute", "Silenzioso", 3, 2, native="speed_mute"),
]

FAN_SPEED_BY_COMMAND: dict[str, FanSpeed] = {fs.command: fs for fs in FAN_SPEEDS}

WIND_LABELS: dict[int, str] = {fs.wind_status: fs.label for fs in FAN_SPEEDS}


COMMAND_GROUPS = [
    {
        "name": "Alimentazione",
        "commands": [
            {"command": "on", "label": "On"},
            {"command": "off", "label": "Off"},
        ],
    },
    {
        "name": "Modo",
        "commands": [
            {"command": "mode_cool", "label": "Freddo"},
            {"command": "mode_heat", "label": "Caldo"},
            {"command": "mode_dry", "label": "Dry"},
            {"command": "mode_fan", "label": "Ventola"},
        ],
    },
    {
        "name": "Ventola",
        "commands": [{"command": fs.command, "label": fs.label} for fs in FAN_SPEEDS],
    },
    {
        "name": "Funzioni",
        "commands": [
            {"command": "turbo_on", "label": "Turbo on"},
            {"command": "turbo_off", "label": "Turbo off"},
            {"command": "energysave_on", "label": "Eco on"},
            {"command": "energysave_off", "label": "Eco off"},
            {"command": "display_on", "label": "Display on"},
            {"command": "display_off", "label": "Display off"},
            {"command": "sleep_1", "label": "Sleep 1"},
            {"command": "sleep_2", "label": "Sleep 2"},
            {"command": "sleep_3", "label": "Sleep 3"},
            {"command": "sleep_4", "label": "Sleep 4"},
            {"command": "sleep_off", "label": "Sleep off"},
        ],
    },
    {
        "name": "Alette",
        "commands": [
            {"command": "vert_dir", "label": "Vert dir"},
            {"command": "vert_swing", "label": "Vert swing"},
            {"command": "hor_dir", "label": "Orizz dir"},
            {"command": "hor_swing", "label": "Orizz swing"},
        ],
    },
    {
        "name": "Unita'",
        "commands": [
            {"command": "temp_to_C", "label": "Celsius"},
            {"command": "temp_to_C_reset_temp", "label": "Celsius reset"},
            {"command": "temp_to_F", "label": "Fahrenheit"},
            {"command": "temp_to_F_reset_temp", "label": "Fahrenheit reset"},
        ],
    },
    {
        "name": "Diagnostica",
        "commands": [
            {"command": "status_102_0", "label": "Stato"},
            {"command": "status_102_64", "label": "Consumi"},
            {"command": "status_3_0", "label": "Status 3.0"},
            {"command": "status_3_1", "label": "Status 3.1"},
            {"command": "status_7_1", "label": "Status 7.1"},
            {"command": "status_10_4", "label": "Status 10.4"},
            {"command": "version", "label": "Versione"},
            {"command": "sync_time", "label": "Invia ora"},
        ],
    },
]

DEVICES = configured_devices()

MODE_LABELS = {
    0: "Ventilatore",
    2: "Freddo",
    4: "Caldo",
    6: "Dry",
}

# Modo atteso dopo un comando mode_* (ottimistico, prima del re-poll).
EXPECTED_MODE_BY_COMMAND = {
    "mode_fan": 0,
    "mode_cool": 2,
    "mode_heat": 4,
    "mode_dry": 6,
}

# wind_status atteso dopo un comando ventola (ottimistico, prima del re-poll).
# Derivato dall'unica tabella FAN_SPEEDS, piu' gli alias nativi della libreria
# e l'euristica mode_fan -> velocita' media.
EXPECTED_WIND_BY_COMMAND = {fs.command: fs.wind_status for fs in FAN_SPEEDS}
EXPECTED_WIND_BY_COMMAND.update(
    {
        "speed_low": FAN_SPEED_BY_COMMAND["speed_1"].wind_status,
        "speed_med": FAN_SPEED_BY_COMMAND["speed_3"].wind_status,
        "speed_max": FAN_SPEED_BY_COMMAND["speed_5"].wind_status,
        "mode_fan": FAN_SPEED_BY_COMMAND["speed_3"].wind_status,
    }
)


@dataclass
class LanCommandResult:
    host: str
    command: str
    ok: bool
    response_hex: str = ""
    response_text: str = ""
    fields: dict[str, Any] | None = None
    error: str | None = None
    attempt: int = 1
    elapsed_ms: int = 0
    metadata: dict[str, Any] | None = None


def device_by_ip(ip: str) -> dict[str, str]:
    for device in DEVICES:
        if device["ip"] == ip:
            return device
    raise ValueError(f"IP non configurato: {ip}")


def update_checksum(payload: bytes) -> bytes:
    data = bytearray(payload)
    checksum = sum(data[2:-4]) & 0xFFFF
    data[-4] = (checksum >> 8) & 0xFF
    data[-3] = checksum & 0xFF
    return bytes(data)


def fan_payload(command: str) -> bytes:
    spec = FAN_SPEED_BY_COMMAND[command]
    if spec.native is not None:
        # auto/mute/low/med/max: pacchetto nativo verificato della libreria
        # (mute imposta anche il bit dedicato, non solo il byte air-volume).
        return UpdateCommand[spec.native].value
    # speed_2 / speed_4: sintetizzati riempiendo i buchi fra le velocita' native.
    data = bytearray(UpdateCommand.speed_low.value)
    data[16] = spec.air_byte
    return update_checksum(bytes(data))


def command_payload(command: str) -> bytes:
    if command == "version":
        return b"AT+XMV"
    if command == "sync_time":
        now = datetime.now().replace(microsecond=0)
        return f"AT+XMT={now:%H,%M,%S}\r\n".encode()
    if command in FAN_SPEED_BY_COMMAND:
        return fan_payload(command)
    if command in ReadCommand.__members__:
        return ReadCommand[command].value
    if command in UpdateCommand.__members__:
        return UpdateCommand[command].value
    raise ValueError(f"comando non supportato: {command}")


def available_command_groups() -> list[dict[str, Any]]:
    temperatures = {
        "name": "Temperatura",
        "commands": [
            {"command": f"temp_{temp}_C", "label": f"{temp} C"}
            for temp in range(16, 33)
        ],
    }
    return [*COMMAND_GROUPS[:3], temperatures, *COMMAND_GROUPS[3:]]


def send_packet(host: str, payload: bytes, timeout: float = DEFAULT_TIMEOUT) -> bytes:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, PORT))
        sock.sendall(payload)
        return sock.recv(512)
    finally:
        sock.close()


def decode_status_102_0(data: bytes) -> dict[str, Any]:
    if len(data) < 15:
        return {}
    packet_type = f"{data[13]}_{data[14]}"
    if packet_type != "102_0":
        return {"packet_type": packet_type}

    try:
        expected = next(rp.value for rp in ResponsePacket if packet_type in rp.name)
    except StopIteration:
        return {"packet_type": packet_type}

    bits = f"{int(data.hex(), 16):08b}"[len(expected) * 8:-24]
    fields: dict[str, Any] = {"packet_type": packet_type}
    wanted = {
        "run_status",
        "mode_status",
        "wind_status",
        "indoor_temperature_setting",
        "indoor_temperature_status",
        "temperature_Fahrenheit",
        "timer",
        "hour",
        "minute",
        "poweron_hour",
        "poweron_minute",
        "poweron_status",
        "poweroff_hour",
        "poweroff_minute",
        "poweroff_status",
        "drying",
        "wind_door",
        "up_down",
        "left_right",
        "nature",
        "heat",
        "low_power",
        "efficient",
        "dual_frequency",
        "mute",
        "back_led",
        "display_led",
        "indicate_led",
        "indoor_led",
    }
    for packet in DataPacket:
        if packet_type not in packet.name:
            continue
        for field in packet.value:
            if field.name not in wanted:
                continue
            raw = bits[field.offset - 1:field.offset + field.length - 1]
            if raw:
                fields[field.name] = int(raw, 2)
        break

    run_status = fields.get("run_status")
    if run_status == 0:
        fields["power"] = "OFF"
    elif run_status == 1:
        fields["power"] = "ON"
    if "mode_status" in fields:
        fields["mode_label"] = MODE_LABELS.get(fields["mode_status"], f"Valore {fields['mode_status']}")
    if "wind_status" in fields:
        fields["wind_label"] = WIND_LABELS.get(fields["wind_status"], f"Valore {fields['wind_status']}")
    if "hour" in fields and "minute" in fields:
        fields["clock"] = f"{fields['hour']:02d}:{fields['minute']:02d}"
    if fields.get("poweron_status") == 1:
        fields["poweron_time"] = f"{fields.get('poweron_hour', 0):02d}:{fields.get('poweron_minute', 0):02d}"
    if fields.get("poweroff_status") == 1:
        fields["poweroff_time"] = f"{fields.get('poweroff_hour', 0):02d}:{fields.get('poweroff_minute', 0):02d}"
    return fields


def execute_lan(
    host: str,
    command: str,
    timeout: float = DEFAULT_TIMEOUT,
    retries: int = DEFAULT_RETRIES,
    retry_pause: float = RETRY_PAUSE,
) -> LanCommandResult:
    device_by_ip(host)
    payload = command_payload(command)
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        start = time.monotonic()
        try:
            data = send_packet(host, payload, timeout=timeout)
            if not data:
                raise RuntimeError("risposta vuota")
            fields = decode_status_102_0(data) if command == "status_102_0" else None
            return LanCommandResult(
                host=host,
                command=command,
                ok=True,
                response_hex=data.hex(),
                response_text=data.decode(errors="replace"),
                fields=fields,
                attempt=attempt,
                elapsed_ms=int((time.monotonic() - start) * 1000),
                metadata=(
                    {"sent_time": datetime.now().replace(microsecond=0).isoformat()}
                    if command == "sync_time"
                    else None
                ),
            )
        except Exception as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(retry_pause)
    return LanCommandResult(
        host=host,
        command=command,
        ok=False,
        error=str(last_error) if last_error else "errore sconosciuto",
        attempt=retries,
    )


def status_all() -> list[dict[str, Any]]:
    results = []
    for index, device in enumerate(DEVICES):
        result = execute_lan(device["ip"], "status_102_0")
        item = {**device, "status": asdict(result)}
        results.append(item)
        if index < len(DEVICES) - 1:
            time.sleep(DEVICE_PAUSE)
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Controllo Hisense AEH-W4A1 via LAN")
    sub = parser.add_subparsers(dest="action", required=True)

    sub.add_parser("devices")
    sub.add_parser("status-all")

    cmd = sub.add_parser("cmd")
    cmd.add_argument("--host", required=True)
    cmd.add_argument("command")

    args = parser.parse_args()
    if args.action == "devices":
        print(json.dumps(DEVICES, indent=2))
        return 0
    if args.action == "status-all":
        print(json.dumps(status_all(), indent=2))
        return 0

    result = execute_lan(args.host, args.command)
    print(json.dumps(asdict(result), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
