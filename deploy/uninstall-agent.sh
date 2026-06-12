#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${PROBE_AGENT_DIR:-/opt/probe-agent}"
SERVICE_NAME="${PROBE_AGENT_SERVICE:-probe-agent}"
RUN_DIR="${PROBE_AGENT_RUN_DIR:-/var/run/probe-agent}"
LOG_DIR="${PROBE_AGENT_LOG_DIR:-/var/log/probe-agent}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo/root because this script removes agent files and services." >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
fi

pid_file="$RUN_DIR/$SERVICE_NAME.pid"
if [ -f "$pid_file" ]; then
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    kill "$pid" >/dev/null 2>&1 || true
  fi
fi

start_script="$INSTALL_DIR/start.sh"
if command -v crontab >/dev/null 2>&1; then
  crontab -l 2>/dev/null | grep -v "$start_script" | crontab - 2>/dev/null || true
fi

rm -rf "$INSTALL_DIR" "$RUN_DIR" "$LOG_DIR"

echo "Probe agent removed."
