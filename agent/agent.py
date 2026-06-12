from __future__ import annotations

import argparse
import configparser
import json
import platform
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psutil
import requests


DEFAULT_CONFIG = Path(__file__).with_name("config.ini")


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


def collect_payload(config: configparser.ConfigParser) -> dict[str, Any]:
    collect = config["collect"]
    net = psutil.net_io_counters()
    disk_path = collect.get("disk_path", "/")

    return {
        "hostname": collect.get("hostname", socket.gethostname()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "cpu_percent": psutil.cpu_percent(interval=1),
        "memory_percent": psutil.virtual_memory().percent,
        "disk_percent": psutil.disk_usage(disk_path).percent,
        "net_sent": int(net.bytes_sent),
        "net_recv": int(net.bytes_recv),
        "uptime_seconds": int(time.time() - psutil.boot_time()),
        "os": f"{platform.system()} {platform.release()}",
        "ip": collect.get("public_ip") or local_ip(),
        "cpu_model": cpu_model(),
        "location": collect.get("location", ""),
        "services": collect_services(collect.get("services", "")),
    }


def apply_remote_config(config: configparser.ConfigParser) -> None:
    server = config["server"]
    collect = config["collect"]
    host = server["host"].rstrip("/")
    token = server["token"]
    hostname = collect.get("hostname", socket.gethostname())

    try:
        response = requests.get(
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
            collect[key] = str(value)

    interval = remote.get("interval_seconds")
    if interval:
        collect["interval_seconds"] = str(interval)


def report_once(config: configparser.ConfigParser) -> dict[str, Any]:
    server = config["server"]
    host = server["host"].rstrip("/")
    token = server["token"]
    payload = collect_payload(config)
    response = requests.post(
        f"{host}/api/report",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
        timeout=10,
    )
    response.raise_for_status()
    return {"payload": payload, "response": response.json()}


def main() -> None:
    parser = argparse.ArgumentParser(description="Probe agent")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="Path to config.ini")
    parser.add_argument("--once", action="store_true", help="Collect and report once")
    args = parser.parse_args()

    config = read_config(Path(args.config))

    while True:
        apply_remote_config(config)
        result = report_once(config)
        print(json.dumps(result, ensure_ascii=False))
        if args.once:
            break
        interval = int(config["collect"].get("interval_seconds", "60"))
        time.sleep(interval)


if __name__ == "__main__":
    main()
