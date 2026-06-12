#!/usr/bin/env bash
set -euo pipefail

REPO_RAW="${PROBE_REPO_RAW:-https://raw.githubusercontent.com/0130-vow/status/main}"
INSTALL_DIR="${PROBE_AGENT_DIR:-/opt/probe-agent}"
CONFIG_PATH="$INSTALL_DIR/config.ini"
SERVICE_NAME="${PROBE_AGENT_SERVICE:-probe-agent}"
RUN_DIR="${PROBE_AGENT_RUN_DIR:-/var/run/probe-agent}"
LOG_DIR="${PROBE_AGENT_LOG_DIR:-/var/log/probe-agent}"

usage() {
  cat <<'EOF'
Usage:
  install-agent.sh --server <url> --token <token> [options]

Options:
  --server      Probe controller URL, for example https://status.777702.xyz
  --token       Bearer token generated on the controller.
  --hostname    Node name. Default: system hostname.
  --interval    Report interval seconds. Default: 60.
  --services    Comma separated checks. Examples: "ssh:22,nginx:80,docker:process=dockerd"
  --public-ip   IP shown on dashboard. Default: auto-detected local IP by agent.
  --location    Free-form location label.

Environment:
  PROBE_REPO_RAW          Raw GitHub base URL.
  PROBE_AGENT_DIR         Install directory. Default: /opt/probe-agent
  PROBE_AGENT_SERVICE     systemd service name. Default: probe-agent
  PROBE_AGENT_RUN_DIR     Runtime directory. Default: /var/run/probe-agent
  PROBE_AGENT_LOG_DIR     Log directory. Default: /var/log/probe-agent
EOF
}

SERVER=""
TOKEN=""
HOSTNAME="$(hostname)"
INTERVAL="60"
SERVICES="ssh:22"
PUBLIC_IP=""
LOCATION=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server)
      SERVER="${2:-}"
      shift 2
      ;;
    --token)
      TOKEN="${2:-}"
      shift 2
      ;;
    --hostname)
      HOSTNAME="${2:-}"
      shift 2
      ;;
    --interval)
      INTERVAL="${2:-}"
      shift 2
      ;;
    --services)
      SERVICES="${2:-}"
      shift 2
      ;;
    --public-ip)
      PUBLIC_IP="${2:-}"
      shift 2
      ;;
    --location)
      LOCATION="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$SERVER" ] || [ -z "$TOKEN" ]; then
  echo "--server and --token are required" >&2
  usage >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo/root because this installer writes $INSTALL_DIR and systemd units." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y python3
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python3
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache python3
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install python3
  else
    echo "python3 is required and no supported package manager was found." >&2
    exit 1
  fi
fi

install_pip_with_package_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y python3-pip python3-venv
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3-pip
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python3-pip
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache py3-pip
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install python3-pip
  else
    return 1
  fi
}

bootstrap_pip() {
  python3 -m ensurepip --upgrade >/dev/null 2>&1 && return 0
  install_pip_with_package_manager >/dev/null 2>&1 && return 0

  tmp_get_pip="$(mktemp)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bootstrap.pypa.io/get-pip.py -o "$tmp_get_pip"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp_get_pip" https://bootstrap.pypa.io/get-pip.py
  else
    echo "curl or wget is required to bootstrap pip." >&2
    rm -f "$tmp_get_pip"
    return 1
  fi
  python3 "$tmp_get_pip"
  rm -f "$tmp_get_pip"
}

install_build_deps() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y build-essential python3-dev
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y gcc python3-devel
  elif command -v yum >/dev/null 2>&1; then
    yum install -y gcc python3-devel
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache gcc python3-dev musl-dev linux-headers
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install gcc python3-devel
  else
    return 1
  fi
}

if ! python3 -m pip --version >/dev/null 2>&1; then
  bootstrap_pip
fi

mkdir -p "$INSTALL_DIR" "$RUN_DIR" "$LOG_DIR"
curl -fsSL "$REPO_RAW/agent/agent.py" -o "$INSTALL_DIR/agent.py"

PIP_FLAGS=()
if python3 -m pip install --help 2>/dev/null | grep -q -- "--break-system-packages"; then
  PIP_FLAGS+=(--break-system-packages)
fi
if ! python3 -m pip install "${PIP_FLAGS[@]}" --upgrade psutil==6.1.1 requests==2.32.3; then
  echo "Python dependency install failed. Installing build dependencies and retrying..." >&2
  install_build_deps
  python3 -m pip install "${PIP_FLAGS[@]}" --upgrade psutil==6.1.1 requests==2.32.3
fi

cat > "$CONFIG_PATH" <<EOF
[server]
host = $SERVER
token = $TOKEN

[collect]
hostname = $HOSTNAME
interval_seconds = $INTERVAL
services = $SERVICES
public_ip = $PUBLIC_IP
location = $LOCATION
EOF

install_systemd_service() {
  cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Probe agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/python3 $INSTALL_DIR/agent.py --config $CONFIG_PATH
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
}

install_nohup_service() {
  start_script="$INSTALL_DIR/start.sh"
  pid_file="$RUN_DIR/$SERVICE_NAME.pid"
  cat > "$start_script" <<EOF
#!/usr/bin/env sh
set -eu
mkdir -p "$RUN_DIR" "$LOG_DIR"
if [ -f "$pid_file" ]; then
  old_pid="\$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "\$old_pid" ] && kill -0 "\$old_pid" 2>/dev/null; then
    exit 0
  fi
fi
cd "$INSTALL_DIR"
nohup /usr/bin/python3 "$INSTALL_DIR/agent.py" --config "$CONFIG_PATH" >> "$LOG_DIR/agent.out.log" 2>> "$LOG_DIR/agent.err.log" &
echo \$! > "$pid_file"
EOF
  chmod +x "$start_script"
  "$start_script"

  if command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -v "$start_script"; echo "@reboot $start_script") | crontab -
  else
    echo "crontab was not found; agent is running now, but startup after reboot was not configured." >&2
  fi
}

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  install_systemd_service
  SERVICE_MODE="systemd"
else
  install_nohup_service
  SERVICE_MODE="nohup"
fi

echo "Probe agent installed and started."
echo "Service: $SERVICE_NAME"
echo "Config: $CONFIG_PATH"
echo "Mode: $SERVICE_MODE"
if [ "$SERVICE_MODE" = "systemd" ]; then
  systemctl --no-pager --full status "$SERVICE_NAME" || true
else
  echo "PID file: $RUN_DIR/$SERVICE_NAME.pid"
  echo "Logs: $LOG_DIR/agent.out.log $LOG_DIR/agent.err.log"
fi
