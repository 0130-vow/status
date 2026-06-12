#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${PROBE_CONFIG:-/home/straw/probe/shared/config.yaml}"
CONTAINER_NAME="${PROBE_CONTAINER:-probe-server}"

usage() {
  cat <<'EOF'
Usage:
  add-agent.sh --hostname <name> [--token <token>]

Options:
  --hostname   Agent hostname that will appear on the dashboard.
  --token      Optional bearer token. If omitted, a random token is generated.

Environment:
  PROBE_CONFIG      Controller config path. Default: /home/straw/probe/shared/config.yaml
  PROBE_CONTAINER   Docker container to restart. Default: probe-server
EOF
}

HOSTNAME=""
TOKEN=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --hostname)
      HOSTNAME="${2:-}"
      shift 2
      ;;
    --token)
      TOKEN="${2:-}"
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

if [ -z "$HOSTNAME" ]; then
  echo "--hostname is required" >&2
  usage >&2
  exit 1
fi

if [ -z "$TOKEN" ]; then
  TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
fi

HOSTNAME="$HOSTNAME" TOKEN="$TOKEN" CONFIG_PATH="$CONFIG_PATH" python3 - <<'PY'
import os
from pathlib import Path

import yaml

path = Path(os.environ["CONFIG_PATH"])
data = yaml.safe_load(path.read_text(encoding="utf-8"))
agents = data.setdefault("server", {}).setdefault("agents", [])
hostname = os.environ["HOSTNAME"]
token = os.environ["TOKEN"]
agents[:] = [agent for agent in agents if agent.get("hostname") != hostname]
agents.append({"hostname": hostname, "token": token})
path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
PY

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  docker restart "$CONTAINER_NAME" >/dev/null
fi

cat <<EOF
Agent registered.

hostname: $HOSTNAME
token: $TOKEN

Install command:
curl -fsSL https://raw.githubusercontent.com/0130-vow/status/main/deploy/install-agent.sh | sudo bash -s -- --server https://status.777702.xyz --hostname $HOSTNAME --token $TOKEN --services "ssh:22"
EOF
