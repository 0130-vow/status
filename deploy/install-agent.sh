#!/usr/bin/env bash
set -euo pipefail

REPO_RAW="${PROBE_REPO_RAW:-https://raw.githubusercontent.com/0130-vow/status/main}"
INSTALL_DIR="${PROBE_AGENT_DIR:-/opt/probe-agent}"
CONFIG_PATH="$INSTALL_DIR/config.ini"
SERVICE_NAME="${PROBE_AGENT_SERVICE:-probe-agent}"

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

if ! python3 -m pip --version >/dev/null 2>&1; then
  bootstrap_pip
fi

mkdir -p "$INSTALL_DIR"
curl -fsSL "$REPO_RAW/agent/agent.py" -o "$INSTALL_DIR/agent.py"

PIP_FLAGS=()
if python3 -m pip install --help 2>/dev/null | grep -q -- "--break-system-packages"; then
  PIP_FLAGS+=(--break-system-packages)
fi
python3 -m pip install "${PIP_FLAGS[@]}" --upgrade psutil==6.1.1 requests==2.32.3

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

echo "Probe agent installed and started."
echo "Service: $SERVICE_NAME"
echo "Config: $CONFIG_PATH"
systemctl --no-pager --full status "$SERVICE_NAME" || true
