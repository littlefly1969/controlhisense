from __future__ import annotations

import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "config.json"

# Valori di esempio (placeholder). I dispositivi reali vanno messi in
# config.json, che e' ignorato da Git. Vedi config.example.json.
DEFAULT_DEVICES = [
    {
        "name": "Condizionatore 1",
        "location": "Zona 1",
        "ip": "192.168.1.101",
        "mac": "b0:41:1d:00:00:01",
        "softap": "AEH-W4A1-b0411d000001",
    },
    {
        "name": "Condizionatore 2",
        "location": "Zona 2",
        "ip": "192.168.1.102",
        "mac": "b0:41:1d:00:00:02",
        "softap": "AEH-W4A1-b0411d000002",
    },
    {
        "name": "Condizionatore 3",
        "location": "Zona 3",
        "ip": "192.168.1.103",
        "mac": "b0:41:1d:00:00:03",
        "softap": "AEH-W4A1-b0411d000003",
    },
    {
        "name": "Condizionatore 4",
        "location": "Zona 4",
        "ip": "192.168.1.104",
        "mac": "b0:41:1d:00:00:04",
        "softap": "AEH-W4A1-b0411d000004",
    },
]

DEFAULT_CONFIG = {
    "auth": {
        "password": "",
        "session_secret": "",
    },
    "devices": DEFAULT_DEVICES,
}


def load_config() -> dict[str, Any]:
    config = json.loads(json.dumps(DEFAULT_CONFIG))
    if CONFIG_FILE.exists():
        with CONFIG_FILE.open("r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        if not isinstance(loaded, dict):
            raise ValueError("config.json deve contenere un oggetto JSON")
        config = merge_dict(config, loaded)
    config["devices"] = normalize_devices(config.get("devices", []))
    return config


def merge_dict(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_dict(result[key], value)
        else:
            result[key] = value
    return result


def normalize_devices(devices: list[dict[str, Any]]) -> list[dict[str, str]]:
    normalized = []
    for index, device in enumerate(devices, start=1):
        if not isinstance(device, dict):
            raise ValueError("ogni dispositivo in config.json deve essere un oggetto")
        ip = str(device.get("ip", "")).strip()
        mac = str(device.get("mac", "")).strip().lower()
        if not ip:
            raise ValueError(f"dispositivo {index}: manca ip")
        if not mac:
            raise ValueError(f"dispositivo {index}: manca mac")
        location = str(device.get("location", "")).strip()
        name = str(device.get("name", "")).strip() or location or f"Condizionatore {index}"
        normalized.append({
            "name": name,
            "location": location or name,
            "ip": ip,
            "mac": mac,
            "softap": str(device.get("softap", "")).strip(),
        })
    return normalized


def configured_devices() -> list[dict[str, str]]:
    return load_config()["devices"]
