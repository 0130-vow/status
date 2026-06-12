from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


UTC = timezone.utc


def utc_now() -> datetime:
    return datetime.now(UTC)


def parse_ts(value: str | None) -> datetime:
    if not value:
        return utc_now()
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat()


class MetricStore:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._lock = threading.Lock()

    def connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path, detect_types=sqlite3.PARSE_DECLTYPES)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def init(self) -> None:
        with self._lock, self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS nodes (
                    hostname TEXT PRIMARY KEY,
                    first_seen TEXT NOT NULL,
                    last_seen TEXT NOT NULL,
                    os TEXT,
                    ip TEXT,
                    cpu_model TEXT,
                    location TEXT,
                    uptime_seconds INTEGER,
                    services_json TEXT NOT NULL DEFAULT '[]'
                );

                CREATE TABLE IF NOT EXISTS metrics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    hostname TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    cpu_percent REAL NOT NULL,
                    memory_percent REAL NOT NULL,
                    disk_percent REAL NOT NULL,
                    net_sent INTEGER NOT NULL,
                    net_recv INTEGER NOT NULL,
                    net_up_bps REAL NOT NULL,
                    net_down_bps REAL NOT NULL,
                    uptime_seconds INTEGER NOT NULL,
                    services_json TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(hostname) REFERENCES nodes(hostname)
                );

                CREATE INDEX IF NOT EXISTS idx_metrics_hostname_id
                    ON metrics(hostname, id DESC);

                CREATE INDEX IF NOT EXISTS idx_metrics_timestamp
                    ON metrics(timestamp);

                CREATE TABLE IF NOT EXISTS alert_states (
                    hostname TEXT NOT NULL,
                    metric TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 0,
                    last_sent TEXT,
                    last_value REAL,
                    PRIMARY KEY(hostname, metric)
                );
                """
            )

    def save_report(self, report: dict[str, Any]) -> dict[str, Any]:
        observed_at = parse_ts(report.get("timestamp"))
        now = utc_now()
        services_json = json.dumps(report.get("services", []), ensure_ascii=False)

        with self._lock, self.connect() as conn:
            previous = conn.execute(
                """
                SELECT timestamp, net_sent, net_recv
                FROM metrics
                WHERE hostname = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (report["hostname"],),
            ).fetchone()

            net_up_bps = 0.0
            net_down_bps = 0.0
            if previous:
                previous_at = parse_ts(previous["timestamp"])
                delta = max((observed_at - previous_at).total_seconds(), 0)
                if delta > 0:
                    sent_delta = int(report["net_sent"]) - int(previous["net_sent"])
                    recv_delta = int(report["net_recv"]) - int(previous["net_recv"])
                    net_up_bps = max(sent_delta, 0) / delta
                    net_down_bps = max(recv_delta, 0) / delta

            conn.execute(
                """
                INSERT INTO nodes (
                    hostname, first_seen, last_seen, os, ip, cpu_model, location,
                    uptime_seconds, services_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(hostname) DO UPDATE SET
                    last_seen = excluded.last_seen,
                    os = excluded.os,
                    ip = excluded.ip,
                    cpu_model = excluded.cpu_model,
                    location = excluded.location,
                    uptime_seconds = excluded.uptime_seconds,
                    services_json = excluded.services_json
                """,
                (
                    report["hostname"],
                    iso(now),
                    iso(now),
                    report.get("os", ""),
                    report.get("ip", ""),
                    report.get("cpu_model", ""),
                    report.get("location", ""),
                    int(report.get("uptime_seconds", 0)),
                    services_json,
                ),
            )

            conn.execute(
                """
                INSERT INTO metrics (
                    hostname, timestamp, cpu_percent, memory_percent, disk_percent,
                    net_sent, net_recv, net_up_bps, net_down_bps, uptime_seconds,
                    services_json, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    report["hostname"],
                    iso(observed_at),
                    float(report["cpu_percent"]),
                    float(report["memory_percent"]),
                    float(report["disk_percent"]),
                    int(report["net_sent"]),
                    int(report["net_recv"]),
                    net_up_bps,
                    net_down_bps,
                    int(report.get("uptime_seconds", 0)),
                    services_json,
                    iso(now),
                ),
            )

        return {
            **report,
            "timestamp": iso(observed_at),
            "net_up_bps": net_up_bps,
            "net_down_bps": net_down_bps,
        }

    def list_nodes(self, thresholds: dict[str, float], stale_after_seconds: int) -> list[dict[str, Any]]:
        stale_delta = timedelta(seconds=stale_after_seconds)
        now = utc_now()
        with self._lock, self.connect() as conn:
            rows = conn.execute(
                """
                SELECT n.*, m.cpu_percent, m.memory_percent, m.disk_percent,
                       m.net_sent, m.net_recv, m.net_up_bps, m.net_down_bps,
                       m.timestamp
                FROM nodes n
                JOIN metrics m ON m.id = (
                    SELECT id FROM metrics
                    WHERE hostname = n.hostname
                    ORDER BY id DESC
                    LIMIT 1
                )
                ORDER BY n.hostname ASC
                """
            ).fetchall()

        nodes: list[dict[str, Any]] = []
        for row in rows:
            last_seen = parse_ts(row["last_seen"])
            offline = now - last_seen > stale_delta
            warn = any(
                float(row[metric]) >= limit
                for metric, limit in thresholds.items()
                if metric in row.keys() and row[metric] is not None
            )
            services = json.loads(row["services_json"] or "[]")
            if any(svc.get("status") not in {"running", "ok"} for svc in services):
                warn = True

            nodes.append(
                {
                    "hostname": row["hostname"],
                    "name": row["hostname"],
                    "status": "offline" if offline else ("warn" if warn else "online"),
                    "last_seen": row["last_seen"],
                    "timestamp": row["timestamp"],
                    "os": row["os"] or "",
                    "ip": row["ip"] or "",
                    "cpu_model": row["cpu_model"] or "",
                    "location": row["location"] or "",
                    "uptime_seconds": int(row["uptime_seconds"] or 0),
                    "cpu_percent": float(row["cpu_percent"]),
                    "memory_percent": float(row["memory_percent"]),
                    "disk_percent": float(row["disk_percent"]),
                    "net_sent": int(row["net_sent"]),
                    "net_recv": int(row["net_recv"]),
                    "net_up_bps": float(row["net_up_bps"]),
                    "net_down_bps": float(row["net_down_bps"]),
                    "services": services,
                }
            )
        return nodes

    def history(self, hostname: str, hours: int) -> list[dict[str, Any]]:
        cutoff = utc_now() - timedelta(hours=hours)
        with self._lock, self.connect() as conn:
            rows = conn.execute(
                """
                SELECT timestamp, cpu_percent, memory_percent, disk_percent,
                       net_up_bps, net_down_bps, services_json
                FROM metrics
                WHERE hostname = ? AND timestamp >= ?
                ORDER BY timestamp ASC
                """,
                (hostname, iso(cutoff)),
            ).fetchall()

        points: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["services"] = json.loads(item.pop("services_json") or "[]")
            points.append(item)
        return points

    def get_alert_state(self, hostname: str, metric: str) -> dict[str, Any] | None:
        with self._lock, self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM alert_states WHERE hostname = ? AND metric = ?",
                (hostname, metric),
            ).fetchone()
        return dict(row) if row else None

    def set_alert_state(self, hostname: str, metric: str, active: bool, value: float, sent: bool) -> None:
        last_sent = iso(utc_now()) if sent else None
        with self._lock, self.connect() as conn:
            conn.execute(
                """
                INSERT INTO alert_states (hostname, metric, active, last_sent, last_value)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(hostname, metric) DO UPDATE SET
                    active = excluded.active,
                    last_sent = COALESCE(excluded.last_sent, alert_states.last_sent),
                    last_value = excluded.last_value
                """,
                (hostname, metric, 1 if active else 0, last_sent, value),
            )

    def delete_node(self, hostname: str) -> dict[str, int]:
        with self._lock, self.connect() as conn:
            metrics = conn.execute("DELETE FROM metrics WHERE hostname = ?", (hostname,)).rowcount or 0
            alerts = conn.execute("DELETE FROM alert_states WHERE hostname = ?", (hostname,)).rowcount or 0
            nodes = conn.execute("DELETE FROM nodes WHERE hostname = ?", (hostname,)).rowcount or 0
        return {"nodes": int(nodes), "metrics": int(metrics), "alert_states": int(alerts)}

    def cleanup(self, retention_days: int) -> int:
        cutoff = utc_now() - timedelta(days=retention_days)
        with self._lock, self.connect() as conn:
            cursor = conn.execute("DELETE FROM metrics WHERE timestamp < ?", (iso(cutoff),))
            return int(cursor.rowcount or 0)
