from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import shlex
import sys
import time
from typing import Any

import yaml
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

if __package__ in {None, ""}:
    sys.path.append(str(Path(__file__).resolve().parents[1]))

from server.config import DEFAULT_CONFIG_PATH, load_config
from server.models import MetricStore, parse_ts
from server.notifier import Notifier


BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("PROBE_CONFIG", DEFAULT_CONFIG_PATH))
CONFIG = load_config(CONFIG_PATH)
STORE = MetricStore(CONFIG.database.path)
NOTIFIER = Notifier(CONFIG.notifier.smtp)
SESSION_COOKIE = "probe_admin_session"
SESSION_TTL_SECONDS = 12 * 60 * 60

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


class RegisterAgentPayload(BaseModel):
    hostname: str = Field(min_length=1, max_length=128)
    server_url: str = "https://status.777702.xyz"
    interval_seconds: int = Field(default=60, ge=5, le=86400)
    services: str = "ssh:22"
    public_ip: str = ""
    location: str = ""
    token: str | None = None


class LoginPayload(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


@app.on_event("startup")
def startup() -> None:
    STORE.init()
    STORE.cleanup(CONFIG.database.retention_days)


def current_config():
    return load_config(CONFIG_PATH)


def cookie_secure(request: Request) -> bool:
    forwarded_proto = request.headers.get("x-forwarded-proto", "")
    return request.url.scheme == "https" or forwarded_proto == "https"


def session_secret() -> bytes:
    config = current_config()
    secret = config.server.admin_session_secret or config.server.admin_password
    if not secret or secret.startswith("change-me-"):
        raise HTTPException(status_code=503, detail="admin login is not configured")
    return secret.encode("utf-8")


def encode_session(username: str) -> str:
    payload = {"u": username, "exp": int(time.time()) + SESSION_TTL_SECONDS}
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    body = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    sig = hmac.new(session_secret(), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def decode_session(value: str | None) -> dict[str, Any] | None:
    if not value or "." not in value:
        return None
    body, sig = value.rsplit(".", 1)
    expected = hmac.new(session_secret(), body.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return None
    padded = body + ("=" * (-len(body) % 4))
    try:
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, json.JSONDecodeError):
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    if payload.get("u") != current_config().server.admin_username:
        return None
    return payload


def require_admin(request: Request) -> str:
    payload = decode_session(request.cookies.get(SESSION_COOKIE))
    if not payload:
        raise HTTPException(status_code=401, detail="login required")
    return str(payload["u"])


def require_agent(payload: ReportPayload, authorization: str | None) -> None:
    expected = current_config().token_for(payload.hostname)
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
    config = current_config()
    cooldown = timedelta(minutes=config.alert.cooldown_minutes)

    for metric, threshold in config.alert.thresholds.items():
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


@app.get("/nodes/{hostname}", response_class=HTMLResponse)
def node_detail(request: Request, hostname: str) -> HTMLResponse:
    return templates.TemplateResponse("node_detail.html", {"request": request, "hostname": hostname})


@app.get("/admin", response_class=HTMLResponse)
def admin(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("admin.html", {"request": request})


@app.get("/api/nodes")
def nodes() -> dict[str, Any]:
    config = current_config()
    return {
        "nodes": STORE.list_nodes(config.alert.thresholds, config.server.stale_after_seconds),
        "thresholds": config.alert.thresholds,
        "stale_after_seconds": config.server.stale_after_seconds,
    }


@app.get("/api/nodes/{hostname}/history")
def node_history(hostname: str, hours: int = 1) -> dict[str, Any]:
    if hours not in {1, 6, 24}:
        raise HTTPException(status_code=400, detail="hours must be one of 1, 6, 24")
    return {"hostname": hostname, "hours": hours, "points": STORE.history(hostname, hours)}


@app.get("/api/admin/session")
def admin_session(request: Request) -> dict[str, Any]:
    payload = decode_session(request.cookies.get(SESSION_COOKIE))
    if not payload:
        return {"authenticated": False}
    return {"authenticated": True, "username": payload["u"]}


@app.post("/api/admin/login")
def admin_login(payload: LoginPayload, request: Request, response: Response) -> dict[str, Any]:
    config = current_config()
    if not config.server.admin_password or config.server.admin_password.startswith("change-me-"):
        raise HTTPException(status_code=503, detail="admin login is not configured")
    valid_user = hmac.compare_digest(payload.username, config.server.admin_username)
    valid_password = hmac.compare_digest(payload.password, config.server.admin_password)
    if not (valid_user and valid_password):
        raise HTTPException(status_code=401, detail="invalid username or password")

    response.set_cookie(
        SESSION_COOKIE,
        encode_session(payload.username),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=cookie_secure(request),
        samesite="lax",
        path="/",
    )
    return {"ok": True, "username": payload.username}


@app.post("/api/admin/logout")
def admin_logout(response: Response) -> dict[str, Any]:
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


def write_agent_credential(hostname: str, token: str) -> None:
    raw = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
    server = raw.setdefault("server", {})
    agents = server.setdefault("agents", [])
    agents[:] = [agent for agent in agents if agent.get("hostname") != hostname]
    agents.append({"hostname": hostname, "token": token})
    CONFIG_PATH.write_text(yaml.safe_dump(raw, allow_unicode=True, sort_keys=False), encoding="utf-8")


def build_install_command(payload: RegisterAgentPayload, token: str) -> str:
    parts = [
        "curl -fsSL https://raw.githubusercontent.com/0130-vow/status/main/deploy/install-agent.sh",
        "| sudo bash -s --",
        f"--server {shlex.quote(payload.server_url.rstrip('/'))}",
        f"--hostname {shlex.quote(payload.hostname)}",
        f"--token {shlex.quote(token)}",
        f"--interval {payload.interval_seconds}",
        f"--services {shlex.quote(payload.services)}",
    ]
    if payload.public_ip:
        parts.append(f"--public-ip {shlex.quote(payload.public_ip)}")
    if payload.location:
        parts.append(f"--location {shlex.quote(payload.location)}")
    return " \\\n  ".join(parts)


@app.post("/api/admin/agents")
def register_agent(
    payload: RegisterAgentPayload,
    request: Request,
) -> dict[str, Any]:
    require_admin(request)
    token = payload.token or secrets.token_hex(32)
    write_agent_credential(payload.hostname, token)
    return {
        "ok": True,
        "hostname": payload.hostname,
        "token": token,
        "install_command": build_install_command(payload, token),
    }


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
