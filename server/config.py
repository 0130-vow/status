from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = ROOT_DIR / "config.yaml"


@dataclass(frozen=True)
class AgentCredential:
    hostname: str
    token: str
    name: str = ""
    services: str = ""
    interval_seconds: int | None = None
    public_ip: str = ""
    location: str = ""


@dataclass(frozen=True)
class ServerSettings:
    host: str
    port: int
    stale_after_seconds: int
    admin_username: str
    admin_password: str
    admin_session_secret: str
    agents: tuple[AgentCredential, ...]


@dataclass(frozen=True)
class DatabaseSettings:
    path: Path
    retention_days: int


@dataclass(frozen=True)
class AlertSettings:
    thresholds: dict[str, float]
    cooldown_minutes: int


@dataclass(frozen=True)
class SMTPSettings:
    enabled: bool
    host: str
    port: int
    use_ssl: bool
    username: str
    password: str
    from_addr: str
    to_addrs: tuple[str, ...]


@dataclass(frozen=True)
class NotifierSettings:
    type: str
    smtp: SMTPSettings


@dataclass(frozen=True)
class AppConfig:
    server: ServerSettings
    database: DatabaseSettings
    alert: AlertSettings
    notifier: NotifierSettings

    def token_for(self, hostname: str) -> str | None:
        for agent in self.server.agents:
            if agent.hostname == hostname:
                return agent.token
        return None


def _as_path(value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return ROOT_DIR / path


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {path}")
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError("Config root must be a mapping")
    return data


def load_config(path: str | Path | None = None) -> AppConfig:
    config_path = Path(path or os.environ.get("PROBE_CONFIG", DEFAULT_CONFIG_PATH))
    raw = _read_yaml(config_path)

    server_raw = raw.get("server", {})
    agents = tuple(
        AgentCredential(
            hostname=str(item["hostname"]),
            token=str(item["token"]),
            name=str(item.get("name", "")),
            services=str(item.get("services", "")),
            interval_seconds=int(item["interval_seconds"]) if item.get("interval_seconds") else None,
            public_ip=str(item.get("public_ip", "")),
            location=str(item.get("location", "")),
        )
        for item in server_raw.get("agents", [])
    )

    database_raw = raw.get("database", {})
    alert_raw = raw.get("alert", {})
    notifier_raw = raw.get("notifier", {})
    smtp_raw = notifier_raw.get("smtp", {})

    return AppConfig(
        server=ServerSettings(
            host=str(server_raw.get("host", "0.0.0.0")),
            port=int(server_raw.get("port", 8000)),
            stale_after_seconds=int(server_raw.get("stale_after_seconds", 180)),
            admin_username=str(os.environ.get("PROBE_ADMIN_USERNAME", server_raw.get("admin_username", "admin"))),
            admin_password=str(os.environ.get("PROBE_ADMIN_PASSWORD", server_raw.get("admin_password", ""))),
            admin_session_secret=str(
                os.environ.get("PROBE_ADMIN_SESSION_SECRET", server_raw.get("admin_session_secret", ""))
            ),
            agents=agents,
        ),
        database=DatabaseSettings(
            path=_as_path(str(database_raw.get("path", "probe.db"))),
            retention_days=int(database_raw.get("retention_days", 30)),
        ),
        alert=AlertSettings(
            thresholds={k: float(v) for k, v in alert_raw.get("thresholds", {}).items()},
            cooldown_minutes=int(alert_raw.get("cooldown_minutes", 30)),
        ),
        notifier=NotifierSettings(
            type=str(notifier_raw.get("type", "smtp")),
            smtp=SMTPSettings(
                enabled=bool(smtp_raw.get("enabled", False)),
                host=str(smtp_raw.get("host", "")),
                port=int(smtp_raw.get("port", 465)),
                use_ssl=bool(smtp_raw.get("use_ssl", True)),
                username=str(smtp_raw.get("username", "")),
                password=str(smtp_raw.get("password", "")),
                from_addr=str(smtp_raw.get("from_addr", "")),
                to_addrs=tuple(str(addr) for addr in smtp_raw.get("to_addrs", [])),
            ),
        ),
    )
