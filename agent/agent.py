from __future__ import annotations

import argparse
import configparser
import json
import platform
import random
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psutil
import requests


DEFAULT_CONFIG = Path(__file__).with_name("config.ini")
DEFAULT_SERVICE_INTERVAL_SECONDS = 300
DEFAULT_CONFIG_INTERVAL_SECONDS = 300
MAX_BACKOFF_SECONDS = 300


def read_config(path: Path) -> configparser.ConfigParser:
    config = configparser.ConfigParser()
    if not config.read(path, encoding="utf-8"):
        raise FileNotFoundError(f"Config file not found: {path}")
    return config


def local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def cpu_model() -> str:
    try:
        info = platform.processor()
        return info or platform.machine()
    except Exception:
        return platform.machine()


def check_tcp(name: str, host: str, port: int, timeout: float = 1.0) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            latency_ms = (time.perf_counter() - started) * 1000
            return {
                "name": name,
                "status": "running",
                "target": f"{host}:{port}",
                "latency_ms": round(latency_ms, 2),
            }
    except OSError:
        return {"name": name, "status": "down", "target": f"{host}:{port}"}


def check_port(name: str, port: int, timeout: float = 1.0) -> dict[str, Any]:
    return check_tcp(name, "127.0.0.1", port, timeout=timeout)


def check_process(name: str, process_name: str) -> dict[str, Any]:
    needle = process_name.lower()
    for proc in psutil.process_iter(["name", "cmdline"]):
        try:
            proc_name = (proc.info.get("name") or "").lower()
            cmdline = " ".join(proc.info.get("cmdline") or []).lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if needle in proc_name or needle in cmdline:
            return {"name": name, "status": "running", "target": f"process:{process_name}"}
    return {"name": name, "status": "down", "target": f"process:{process_name}"}


def collect_services(raw: str) -> list[dict[str, Any]]:
    services: list[dict[str, Any]] = []
    for item in [part.strip() for part in raw.split(",") if part.strip()]:
        if ":" not in item:
            services.append(check_process(item, item))
            continue

        name, target = [part.strip() for part in item.split(":", 1)]
        if target.isdigit():
            services.append(check_port(name, int(target)))
        elif ":" in target and target.rsplit(":", 1)[1].isdigit():
            host, port = target.rsplit(":", 1)
            services.append(check_tcp(name, host, int(port)))
        elif target.startswith("process="):
            services.append(check_process(name, target.split("=", 1)[1]))
        else:
            services.append({"name": name, "status": "unknown", "target": target})
    return services


class AgentRuntime:
    def __init__(self, config: configparser.ConfigParser):
        self.config = config
        self.session = requests.Session()
        self._last_config_check = 0.0
        self._last_services_raw = ""
        self._last_services_check = 0.0
        self._services_cache: list[dict[str, Any]] = []
        self._os = f"{platform.system()} {platform.release()}"
        self._cpu_model = cpu_model()
        self._local_ip = local_ip()
        psutil.cpu_percent(interval=None)

    @property
    def collect(self) -> configparser.SectionProxy:
        return self.config["collect"]

    @property
    def server(self) -> configparser.SectionProxy:
        return self.config["server"]

    def interval_seconds(self) -> int:
        return max(5, int(self.collect.get("interval_seconds", "60")))

    def service_interval_seconds(self) -> int:
        configured = self.collect.get("service_interval_seconds", "")
        if configured:
            return max(5, int(configured))
        return max(DEFAULT_SERVICE_INTERVAL_SECONDS, self.interval_seconds() * 5)

    def config_interval_seconds(self) -> int:
        configured = self.collect.get("config_interval_seconds", "")
        if configured:
            return max(30, int(configured))
        return max(DEFAULT_CONFIG_INTERVAL_SECONDS, self.interval_seconds() * 5)

    def jitter_seconds(self, base: float | None = None) -> float:
        interval = base if base is not None else self.interval_seconds()
        return random.uniform(0, max(1.0, interval * 0.15))

    def maybe_apply_remote_config(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_config_check < self.config_interval_seconds():
            return

        self._last_config_check = now
        host = self.server["host"].rstrip("/")
        token = self.server["token"]
        hostname = self.collect.get("hostname", socket.gethostname())

        try:
            response = self.session.get(
                f"{host}/api/agent/config/{hostname}",
                headers={"Authorization": f"Bearer {token}"},
                timeout=5,
            )
            if response.status_code == 404:
                return
            response.raise_for_status()
            remote = response.json()
        except requests.RequestException:
            return

        for key in ("services", "public_ip", "location"):
            value = remote.get(key)
            if value is not None:
                self.collect[key] = str(value)

        interval = remote.get("interval_seconds")
        if interval:
            self.collect["interval_seconds"] = str(interval)

    def services(self) -> list[dict[str, Any]]:
        raw = self.collect.get("services", "")
        now = time.monotonic()
        if raw == self._last_services_raw and now - self._last_services_check < self.service_interval_seconds():
            return [dict(item) for item in self._services_cache]

        services = collect_services(raw)
        self._last_services_raw = raw
        self._last_services_check = now
        self._services_cache = [dict(item) for item in services]
        return services

    def collect_payload(self) -> dict[str, Any]:
        collect = self.collect
        net = psutil.net_io_counters()
        disk_path = collect.get("disk_path", "/")

        return {
            "hostname": collect.get("hostname", socket.gethostname()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "cpu_percent": psutil.cpu_percent(interval=None),
            "memory_percent": psutil.virtual_memory().percent,
            "disk_percent": psutil.disk_usage(disk_path).percent,
            "net_sent": int(net.bytes_sent),
            "net_recv": int(net.bytes_recv),
            "uptime_seconds": int(time.time() - psutil.boot_time()),
            "os": self._os,
            "ip": collect.get("public_ip") or self._local_ip,
            "cpu_model": self._cpu_model,
            "location": collect.get("location", ""),
            "services": self.services(),
        }

    def report_once(self) -> dict[str, Any]:
        host = self.server["host"].rstrip("/")
        token = self.server["token"]
        payload = self.collect_payload()
        response = self.session.post(
            f"{host}/api/report",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
            timeout=10,
        )
        response.raise_for_status()
        return {"payload": payload, "response": response.json()}


def collect_payload(config: configparser.ConfigParser) -> dict[str, Any]:
    runtime = AgentRuntime(config)
    return runtime.collect_payload()


def apply_remote_config(config: configparser.ConfigParser) -> None:
    AgentRuntime(config).maybe_apply_remote_config(force=True)


def report_once(config: configparser.ConfigParser) -> dict[str, Any]:
    runtime = AgentRuntime(config)
    runtime.maybe_apply_remote_config(force=True)
    return runtime.report_once()


def main() -> None:
    parser = argparse.ArgumentParser(description="Probe agent")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="Path to config.ini")
    parser.add_argument("--once", action="store_true", help="Collect and report once")
    args = parser.parse_args()

    runtime = AgentRuntime(read_config(Path(args.config)))
    failures = 0

    while True:
        try:
            runtime.maybe_apply_remote_config(force=args.once)
            result = runtime.report_once()
            failures = 0
            print(json.dumps(result, ensure_ascii=False), flush=True)
        except requests.RequestException as error:
            failures += 1
            print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), flush=True)
            if args.once:
                raise SystemExit(1) from error

        if args.once:
            break

        interval = runtime.interval_seconds()
        if failures:
            interval = min(MAX_BACKOFF_SECONDS, interval * (2 ** min(failures, 5)))
        time.sleep(interval + runtime.jitter_seconds(interval))


if __name__ == "__main__":
    main()
