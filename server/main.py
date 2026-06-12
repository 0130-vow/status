from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from typing import Any

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

if __package__ in {None, ""}:
    sys.path.append(str(Path(__file__).resolve().parents[1]))

from server.config import load_config
from server.models import MetricStore, parse_ts
from server.notifier import Notifier


BASE_DIR = Path(__file__).resolve().parent
CONFIG = load_config()
STORE = MetricStore(CONFIG.database.path)
NOTIFIER = Notifier(CONFIG.notifier.smtp)

app = FastAPI(title="Probe", version="0.1.0")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


class ServiceStatus(BaseModel):
    name: str
    status: str
    target: str | None = None
    latency_ms: float | None = None


class ReportPayload(BaseModel):
    hostname: str = Field(min_length=1, max_length=128)
    timestamp: str | None = None
    cpu_percent: float = Field(ge=0, le=100)
    memory_percent: float = Field(ge=0, le=100)
    disk_percent: float = Field(ge=0, le=100)
    net_sent: int = Field(ge=0)
    net_recv: int = Field(ge=0)
    uptime_seconds: int = Field(ge=0)
    os: str = ""
    ip: str = ""
    cpu_model: str = ""
    location: str = ""
    services: list[ServiceStatus] = Field(default_factory=list)


@app.on_event("startup")
def startup() -> None:
    STORE.init()
    STORE.cleanup(CONFIG.database.retention_days)


def require_agent(payload: ReportPayload, authorization: str | None) -> None:
    expected = CONFIG.token_for(payload.hostname)
    if expected is None:
        raise HTTPException(status_code=403, detail="unknown agent hostname")
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len(prefix) :].strip()
    if token != expected:
        raise HTTPException(status_code=401, detail="invalid bearer token")


def should_send(state: dict[str, Any] | None, cooldown: timedelta) -> bool:
    if not state or not state.get("last_sent"):
        return True
    last_sent = parse_ts(str(state["last_sent"]))
    return datetime.now(timezone.utc) - last_sent >= cooldown


def check_alerts(saved: dict[str, Any]) -> None:
    hostname = str(saved["hostname"])
    cooldown = timedelta(minutes=CONFIG.alert.cooldown_minutes)

    for metric, threshold in CONFIG.alert.thresholds.items():
        value = float(saved.get(metric, 0))
        active_now = value >= threshold
        state = STORE.get_alert_state(hostname, metric)
        active_before = bool(state and state.get("active"))

        if active_now and should_send(state, cooldown):
            NOTIFIER.send(
                f"[Probe] {hostname} {metric} alert",
                f"{hostname} {metric} is {value:.1f}, threshold is {threshold:.1f}.",
            )
            STORE.set_alert_state(hostname, metric, True, value, sent=True)
        elif active_now and not active_before:
            STORE.set_alert_state(hostname, metric, True, value, sent=False)
        elif not active_now and active_before:
            NOTIFIER.send(
                f"[Probe] {hostname} {metric} recovered",
                f"{hostname} {metric} recovered to {value:.1f}, threshold is {threshold:.1f}.",
            )
            STORE.set_alert_state(hostname, metric, False, value, sent=True)
        elif state is None:
            STORE.set_alert_state(hostname, metric, False, value, sent=False)


@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("dashboard.html", {"request": request})


@app.get("/api/nodes")
def nodes() -> dict[str, Any]:
    return {
        "nodes": STORE.list_nodes(CONFIG.alert.thresholds, CONFIG.server.stale_after_seconds),
        "thresholds": CONFIG.alert.thresholds,
        "stale_after_seconds": CONFIG.server.stale_after_seconds,
    }


@app.get("/api/nodes/{hostname}/history")
def node_history(hostname: str, hours: int = 1) -> dict[str, Any]:
    if hours not in {1, 6, 24}:
        raise HTTPException(status_code=400, detail="hours must be one of 1, 6, 24")
    return {"hostname": hostname, "hours": hours, "points": STORE.history(hostname, hours)}


@app.post("/api/report")
def report(payload: ReportPayload, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_agent(payload, authorization)
    saved = STORE.save_report(payload.dict())
    check_alerts(saved)
    return {"ok": True, "hostname": payload.hostname}


def main() -> None:
    uvicorn.run("server.main:app", host=CONFIG.server.host, port=CONFIG.server.port, reload=False)


if __name__ == "__main__":
    main()
