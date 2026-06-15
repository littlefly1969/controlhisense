#!/usr/bin/env python3
import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import threading
import time
from dataclasses import asdict
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ac_discovery import DEFAULT_PORTS, discover, wifi_scan
from aeh_ap_control import DEFAULT_AP_PASSWORD, DEFAULT_IFACE, execute
from aeh_lan_control import (
    DEVICES,
    DEVICE_PAUSE,
    MODE_LABELS,
    WIND_LABELS,
    available_command_groups,
    execute_lan,
    status_all,
)
from app_config import load_config


ROOT = Path(__file__).resolve().parent
WEBAPP_DIR = ROOT / "webapp"
TIMERS_FILE = ROOT / "timers.json"
APP_CONFIG = load_config()

POLL_INTERVAL_SECONDS = 5 * 60
TIME_SYNC_INTERVAL_SECONDS = 60 * 60
SCHEDULER_TICK_SECONDS = 20
SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
TIMER_GRACE_MINUTES = 10
TIMER_RETRY_SECONDS = 60

AC_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
TIMER_LOCK = threading.Lock()

APP_STATE = {
    "devices": [{**device, "status": None} for device in DEVICES],
    "commands": available_command_groups(),
    "last_poll": None,
    "last_time_sync": None,
    "last_timer_run": None,
    "last_action": None,
    "poll_interval_seconds": POLL_INTERVAL_SECONDS,
    "time_sync_interval_seconds": TIME_SYNC_INTERVAL_SECONDS,
    "busy": False,
}

CONFIG = {
    "password_hash": "",
    "session_secret": secrets.token_hex(32),
    "dev_no_auth": False,
    "secure_cookies": False,
}

EXPECTED_MODE_BY_COMMAND = {
    "mode_fan": 0,
    "mode_heat": 2,
    "mode_cool": 4,
    "mode_dry": 6,
}

EXPECTED_WIND_BY_COMMAND = {
    "mode_fan": 6,
    "speed_auto": 0,
    "speed_mute": 2,
    "speed_low": 4,
    "speed_med": 6,
    "speed_max": 8,
}

PUBLIC_ASSETS = {
    "/styles.css",
    "/manifest.webmanifest",
    "/sw.js",
    "/icon.svg",
}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def today_key() -> str:
    return time.strftime("%Y-%m-%d")


def current_weekday() -> int:
    return int(time.strftime("%w"))


def current_hhmm() -> str:
    return time.strftime("%H:%M")


def minute_of_day(hhmm: str) -> int:
    hour, minute = hhmm.split(":")
    return int(hour) * 60 + int(minute)


def timer_succeeded_today(timer: dict, today: str) -> bool:
    if timer.get("last_run_date") != today:
        return False
    last_result = timer.get("last_result")
    return not isinstance(last_result, dict) or last_result.get("ok") is not False


def timer_retry_wait_elapsed(timer: dict) -> bool:
    try:
        last_attempt_epoch = float(timer.get("last_attempt_epoch", 0))
    except (TypeError, ValueError):
        return True
    return time.time() - last_attempt_epoch >= TIMER_RETRY_SECONDS


def timer_runtime_status(timer: dict) -> dict:
    now_day = current_weekday()
    now_minute = minute_of_day(current_hhmm())
    try:
        timer_minute = minute_of_day(str(timer.get("at", "00:00")))
    except ValueError:
        return {"state": "invalid-time", "server_hhmm": current_hhmm(), "server_weekday": now_day}
    due_delta = now_minute - timer_minute
    today = today_key()
    enabled = bool(timer.get("enabled"))
    day_matches = now_day in timer.get("days", [])
    in_window = 0 <= due_delta <= TIMER_GRACE_MINUTES
    succeeded = timer_succeeded_today(timer, today)
    retry_wait_elapsed = timer_retry_wait_elapsed(timer)
    state = "waiting"
    if not enabled:
        state = "disabled"
    elif not day_matches:
        state = "wrong-day"
    elif succeeded:
        state = "done-today"
    elif due_delta < 0:
        state = "not-yet"
    elif due_delta > TIMER_GRACE_MINUTES:
        state = "missed-window"
    elif not retry_wait_elapsed:
        state = "retry-wait"
    elif in_window:
        state = "due"
    return {
        "state": state,
        "server_hhmm": current_hhmm(),
        "server_weekday": now_day,
        "due_delta_minutes": due_delta,
        "grace_minutes": TIMER_GRACE_MINUTES,
        "retry_wait_elapsed": retry_wait_elapsed,
    }


def state_snapshot() -> dict:
    with STATE_LOCK:
        snapshot = json.loads(json.dumps(APP_STATE))
    snapshot["server_time"] = now_iso()
    snapshot["server_hhmm"] = current_hhmm()
    snapshot["server_weekday"] = current_weekday()
    snapshot["scheduler_tick_seconds"] = SCHEDULER_TICK_SECONDS
    snapshot["timer_grace_minutes"] = TIMER_GRACE_MINUTES
    snapshot["timers"] = [
        {**timer, "runtime": timer_runtime_status(timer)}
        for timer in load_timers()
    ]
    return snapshot


def set_busy(value: bool, action: str | None = None) -> None:
    with STATE_LOCK:
        APP_STATE["busy"] = value
        if action:
            APP_STATE["last_action"] = action


def update_cached_status(host: str, status: dict) -> None:
    with STATE_LOCK:
        for index, device in enumerate(APP_STATE["devices"]):
            if device["ip"] == host:
                status = preserve_missing_status_fields(device.get("status"), status)
                APP_STATE["devices"][index] = {**device, "status": status}
                break


def preserve_missing_status_fields(previous_status: dict | None, status: dict) -> dict:
    if not isinstance(status, dict):
        return status
    fields = status.get("fields")
    previous_fields = (previous_status or {}).get("fields")
    if not isinstance(fields, dict) or not isinstance(previous_fields, dict):
        return status
    merged = dict(fields)
    for key in ("mode_status", "mode_label", "wind_status", "wind_label"):
        if key not in merged and key in previous_fields:
            merged[key] = previous_fields[key]
    return {**status, "fields": merged}


def expected_fields_for_command(command: str) -> dict:
    fields = {}
    mode = EXPECTED_MODE_BY_COMMAND.get(command)
    if mode is not None:
        fields["mode_status"] = mode
        fields["mode_label"] = MODE_LABELS.get(mode, f"Valore {mode}")
    wind = EXPECTED_WIND_BY_COMMAND.get(command)
    if wind is not None:
        fields["wind_status"] = wind
        fields["wind_label"] = WIND_LABELS.get(wind, f"Valore {wind}")
    return fields


def update_cached_fields(host: str, fields: dict) -> None:
    if not fields:
        return
    with STATE_LOCK:
        for index, device in enumerate(APP_STATE["devices"]):
            if device["ip"] != host:
                continue
            status = device.get("status") or {"host": host, "command": "cached-state", "ok": True}
            current_fields = status.get("fields") if isinstance(status.get("fields"), dict) else {}
            APP_STATE["devices"][index] = {
                **device,
                "status": {
                    **status,
                    "fields": {**current_fields, **fields},
                },
            }
            break


def poll_all_devices(reason: str = "poll") -> list[dict]:
    set_busy(True, reason)
    try:
        with AC_LOCK:
            devices = status_all()
        with STATE_LOCK:
            previous_by_ip = {device["ip"]: device.get("status") for device in APP_STATE["devices"]}
            APP_STATE["devices"] = [
                {
                    **device,
                    "status": preserve_missing_status_fields(previous_by_ip.get(device["ip"]), device.get("status")),
                }
                for device in devices
            ]
            APP_STATE["last_poll"] = now_iso()
            APP_STATE["last_action"] = reason
        return devices
    finally:
        set_busy(False)


def poll_one_device(host: str, reason: str = "single-poll") -> dict:
    set_busy(True, reason)
    try:
        with AC_LOCK:
            result = execute_lan(host=host, command="status_102_0")
        status = asdict(result)
        update_cached_status(host, status)
        return status
    finally:
        set_busy(False)


def sync_time_all(reason: str = "sync-time") -> list[dict]:
    set_busy(True, reason)
    results = []
    try:
        with AC_LOCK:
            for index, device in enumerate(DEVICES):
                result = execute_lan(
                    host=device["ip"],
                    command="sync_time",
                    timeout=2,
                    retries=1,
                    retry_pause=0,
                )
                results.append({**device, "time_sync": asdict(result)})
                if index < len(DEVICES) - 1:
                    time.sleep(DEVICE_PAUSE)
        with STATE_LOCK:
            APP_STATE["last_time_sync"] = now_iso()
            APP_STATE["last_action"] = reason
        return results
    finally:
        set_busy(False)


def load_timers() -> list[dict]:
    with TIMER_LOCK:
        try:
            with TIMERS_FILE.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            return []
        if not isinstance(data, list):
            return []
        return data


def save_timers(timers: list[dict]) -> None:
    with TIMER_LOCK:
        with TIMERS_FILE.open("w", encoding="utf-8") as fh:
            json.dump(timers, fh, indent=2, sort_keys=True)
            fh.write("\n")


def validate_timer(payload: dict, existing_id: str | None = None) -> dict:
    host = str(payload.get("host", "")).strip()
    if host not in {device["ip"] for device in DEVICES}:
        raise ValueError("host non configurato")
    command = str(payload.get("command", "")).strip()
    if command not in {"on", "off"}:
        raise ValueError("il timer server supporta solo on/off")
    at = str(payload.get("at", "")).strip()
    if len(at) != 5 or at[2] != ":":
        raise ValueError("orario non valido, usa HH:MM")
    hour, minute = at.split(":")
    if not (hour.isdigit() and minute.isdigit() and 0 <= int(hour) <= 23 and 0 <= int(minute) <= 59):
        raise ValueError("orario non valido, usa HH:MM")
    days = payload.get("days", [0, 1, 2, 3, 4, 5, 6])
    if not isinstance(days, list) or any(day not in range(7) for day in days):
        raise ValueError("giorni non validi")
    return {
        "id": existing_id or secrets.token_hex(8),
        "host": host,
        "command": command,
        "at": at,
        "days": sorted(set(days)),
        "enabled": bool(payload.get("enabled", True)),
        "label": str(payload.get("label", "")).strip()[:80],
        "last_run_date": str(payload.get("last_run_date", "")),
        "last_run_at": str(payload.get("last_run_at", "")),
        "last_attempt_at": str(payload.get("last_attempt_at", "")),
        "last_attempt_epoch": payload.get("last_attempt_epoch", 0),
        "last_result": payload.get("last_result"),
    }


def create_timer(payload: dict) -> dict:
    timer = validate_timer(payload)
    timers = load_timers()
    timers.append(timer)
    save_timers(timers)
    return timer


def update_timer(timer_id: str, payload: dict) -> dict:
    timers = load_timers()
    for index, timer in enumerate(timers):
        if timer["id"] == timer_id:
            merged = {**timer, **payload}
            timers[index] = validate_timer(merged, existing_id=timer_id)
            save_timers(timers)
            return timers[index]
    raise ValueError("timer non trovato")


def delete_timer(timer_id: str) -> dict:
    timers = load_timers()
    kept = [timer for timer in timers if timer.get("id") != timer_id]
    if len(kept) == len(timers):
        raise ValueError("timer non trovato")
    save_timers(kept)
    return {"ok": True, "id": timer_id}


def run_due_timers() -> None:
    timers = load_timers()
    if not timers:
        return
    now_day = current_weekday()
    now_minute = minute_of_day(current_hhmm())
    today = today_key()
    changed = False
    for timer in timers:
        if not timer.get("enabled"):
            continue
        due_delta = now_minute - minute_of_day(timer.get("at", "00:00"))
        if due_delta < 0 or due_delta > TIMER_GRACE_MINUTES:
            continue
        if now_day not in timer.get("days", []):
            continue
        if timer_succeeded_today(timer, today):
            continue
        if not timer_retry_wait_elapsed(timer):
            continue
        host = timer["host"]
        command = timer["command"]
        set_busy(True, f"timer:{host}:{command}")
        try:
            attempted_at = now_iso()
            timer["last_attempt_at"] = attempted_at
            timer["last_attempt_epoch"] = time.time()
            with AC_LOCK:
                result = execute_lan(host=host, command=command)
            timer["last_result"] = asdict(result)
            changed = True
            if not result.ok:
                print(f"Timer fallito: {host} {command}: {result.error}", flush=True)
                continue
            timer["last_run_date"] = today
            timer["last_run_at"] = attempted_at
            with STATE_LOCK:
                APP_STATE["last_timer_run"] = timer["last_run_at"]
                APP_STATE["last_action"] = f"timer:{host}:{command}"
            poll_one_device(host, "post-timer-single-poll")
        except Exception as exc:
            timer["last_result"] = {"ok": False, "error": str(exc)}
            timer["last_attempt_at"] = now_iso()
            timer["last_attempt_epoch"] = time.time()
            changed = True
            print(f"Timer fallito: {host} {command}: {exc}", flush=True)
        finally:
            set_busy(False)
    if changed:
        save_timers(timers)


def scheduler_loop() -> None:
    try:
        sync_time_all("startup-time-sync")
    except Exception as exc:
        print(f"Scheduler startup-time-sync fallito: {exc}", flush=True)
    try:
        poll_all_devices("startup-poll")
    except Exception as exc:
        print(f"Scheduler startup-poll fallito: {exc}", flush=True)
    next_poll = time.monotonic() + POLL_INTERVAL_SECONDS
    next_time_sync = time.monotonic() + TIME_SYNC_INTERVAL_SECONDS
    while True:
        try:
            run_due_timers()
            now = time.monotonic()
            if now >= next_time_sync:
                sync_time_all("scheduled-time-sync")
                next_time_sync = now + TIME_SYNC_INTERVAL_SECONDS
                next_poll = now + POLL_INTERVAL_SECONDS
            elif now >= next_poll:
                poll_all_devices("scheduled-poll")
                next_poll = now + POLL_INTERVAL_SECONDS
        except Exception as exc:
            print(f"Scheduler errore: {exc}", flush=True)
            with STATE_LOCK:
                APP_STATE["last_action"] = f"scheduler-error:{exc}"
        time.sleep(SCHEDULER_TICK_SECONDS)


def password_hash(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def verify_password(password: str) -> bool:
    if CONFIG["dev_no_auth"]:
        return True
    return hmac.compare_digest(password_hash(password), CONFIG["password_hash"])


def sign_session(expires: int) -> str:
    body = f"{expires}"
    signature = hmac.new(CONFIG["session_secret"].encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def valid_session(value: str) -> bool:
    try:
        body, signature = value.rsplit(".", 1)
        expires = int(body)
    except (ValueError, AttributeError):
        return False
    expected = hmac.new(CONFIG["session_secret"].encode(), body.encode(), hashlib.sha256).hexdigest()
    return expires > int(time.time()) and hmac.compare_digest(signature, expected)


class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        path = urlparse(self.path).path
        if path == "/login":
            self.serve_static("login.html", send_body=False)
            return
        if path in PUBLIC_ASSETS:
            self.serve_static(path.lstrip("/"), send_body=False)
            return
        if path.startswith("/api/"):
            if not self.require_auth(send_body=False):
                return
            if path in {"/api/session", "/api/devices", "/api/status", "/api/timers"}:
                self.reply_json({}, send_body=False)
                return
            self.send_error(404)
            return
        if not self.require_auth(send_body=False):
            return
        self.serve_static("index.html" if path == "/" else path.lstrip("/"), send_body=False)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/login":
            self.serve_static("login.html")
            return
        if path in PUBLIC_ASSETS:
            self.serve_static(path.lstrip("/"))
            return
        if path == "/api/session":
            self.require_auth()
            self.reply_json({"ok": True})
            return
        if path.startswith("/api/"):
            if not self.require_auth():
                return
            self.handle_api_get(path)
            return
        if not self.require_auth():
            return
        self.serve_static("index.html" if path == "/" else path.lstrip("/"))

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/login":
            self.handle_login()
            return
        if not self.require_auth():
            return
        if path == "/api/logout":
            self.reply_json({"ok": True}, clear_cookie=True)
            return
        self.handle_api_post(path)

    def do_PUT(self):
        if not self.require_auth():
            return
        self.handle_api_put(urlparse(self.path).path)

    def do_DELETE(self):
        if not self.require_auth():
            return
        self.handle_api_delete(urlparse(self.path).path)

    def handle_api_get(self, path: str) -> None:
        if path == "/api/devices":
            self.reply_json(state_snapshot()["devices"])
            return
        if path == "/api/status":
            query = parse_qs(urlparse(self.path).query)
            if query.get("refresh", ["0"])[0] in ("1", "true", "yes"):
                poll_all_devices("manual-poll")
            self.reply_json(state_snapshot())
            return
        if path == "/api/timers":
            self.reply_json(load_timers())
            return
        if path == "/api/scan":
            report = discover("192.168.1.0/24", DEFAULT_PORTS, include_vendors=True)
            report["wifi"] = wifi_scan()
            self.reply_json(report)
            return
        self.send_error(404)

    def handle_api_post(self, path: str) -> None:
        try:
            payload = self.read_json()
            if path == "/api/lan-command":
                host = payload["host"]
                command = payload["command"]
                set_busy(True, f"{host}:{command}")
                try:
                    with AC_LOCK:
                        result = execute_lan(host=host, command=command)
                    body = asdict(result)
                    if result.ok:
                        update_cached_fields(host, expected_fields_for_command(command))
                    if command == "status_102_0":
                        update_cached_status(host, body)
                    set_busy(False)
                    if command != "status_102_0":
                        body["refreshed_status"] = poll_one_device(host, "post-command-single-poll")
                    self.reply_json(body)
                finally:
                    set_busy(False)
                return
            if path == "/api/sync-time":
                self.reply_json(sync_time_all("manual-time-sync"))
                return
            if path == "/api/timers":
                self.reply_json(create_timer(payload), status=201)
                return
            if path == "/api/softap-command":
                result = execute(
                    command=payload["command"],
                    ssid=payload["ssid"],
                    iface=payload.get("iface", DEFAULT_IFACE),
                    password=payload.get("password", DEFAULT_AP_PASSWORD),
                    host=payload.get("host", "192.168.1.10"),
                    source_ip=payload.get("source_ip") or None,
                )
                self.reply_json(result.__dict__)
                return
            self.send_error(404)
        except Exception as exc:
            self.reply_json({"ok": False, "error": str(exc)}, status=500)

    def handle_api_put(self, path: str) -> None:
        if path != "/api/timers":
            self.send_error(404)
            return
        try:
            payload = self.read_json()
            self.reply_json(update_timer(payload["id"], payload))
        except Exception as exc:
            self.reply_json({"ok": False, "error": str(exc)}, status=500)

    def handle_api_delete(self, path: str) -> None:
        if path != "/api/timers":
            self.send_error(404)
            return
        try:
            query = parse_qs(urlparse(self.path).query)
            self.reply_json(delete_timer(query.get("id", [""])[0]))
        except Exception as exc:
            self.reply_json({"ok": False, "error": str(exc)}, status=500)

    def handle_login(self) -> None:
        try:
            payload = self.read_json()
            if not verify_password(str(payload.get("password", ""))):
                self.reply_json({"ok": False, "error": "password errata"}, status=401)
                return
            expires = int(time.time()) + SESSION_TTL_SECONDS
            session = sign_session(expires)
            attrs = ["ac_session=" + session, "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={SESSION_TTL_SECONDS}"]
            if CONFIG["secure_cookies"]:
                attrs.append("Secure")
            self.send_response(200)
            self.send_header("Set-Cookie", "; ".join(attrs))
            self.send_header("Content-Type", "application/json")
            body = b'{"ok": true}'
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            self.reply_json({"ok": False, "error": str(exc)}, status=500)

    def require_auth(self, send_body: bool = True) -> bool:
        if CONFIG["dev_no_auth"]:
            return True
        cookie_header = self.headers.get("Cookie", "")
        jar = cookies.SimpleCookie(cookie_header)
        morsel = jar.get("ac_session")
        if morsel and valid_session(morsel.value):
            return True
        if self.path.startswith("/api/"):
            self.reply_json({"ok": False, "error": "non autenticato"}, status=401, send_body=send_body)
        else:
            self.send_response(302)
            self.send_header("Location", "/login")
            self.end_headers()
        return False

    def serve_static(self, relative_path: str, send_body: bool = True) -> None:
        path = (WEBAPP_DIR / relative_path).resolve()
        if not str(path).startswith(str(WEBAPP_DIR.resolve())) or not path.is_file():
            self.send_error(404)
            return
        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".webmanifest":
            content_type = "application/manifest+json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def reply_json(self, body, status: int = 200, clear_cookie: bool = False, send_body: bool = True) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        if clear_cookie:
            self.send_header("Set-Cookie", "ac_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if send_body:
            self.wfile.write(data)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--dev-no-auth", action="store_true")
    parser.add_argument("--secure-cookies", action="store_true")
    args = parser.parse_args()

    auth_config = APP_CONFIG.get("auth", {})
    password = os.environ.get("AC_WEB_PASSWORD") or auth_config.get("password", "")
    if not password and not args.dev_no_auth:
        raise SystemExit("Imposta AC_WEB_PASSWORD oppure usa --dev-no-auth solo in locale.")

    CONFIG["password_hash"] = password_hash(password) if password else ""
    CONFIG["session_secret"] = (
        os.environ.get("AC_SESSION_SECRET")
        or auth_config.get("session_secret")
        or secrets.token_hex(32)
    )
    CONFIG["dev_no_auth"] = args.dev_no_auth
    CONFIG["secure_cookies"] = args.secure_cookies

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    scheduler = threading.Thread(target=scheduler_loop, daemon=True)
    scheduler.start()
    print(f"http://{args.host}:{args.port}")
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
