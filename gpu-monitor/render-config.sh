#!/usr/bin/env bash
# Renders the systemd unit and crontab templates for this machine.
# Usage: gpu-monitor/render-config.sh [output-dir]   (default: .local/)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/.local}"
NODE_BIN="${GPU_MONITOR_NODE:-$(command -v node)}"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH; set GPU_MONITOR_NODE to its absolute path." >&2
  exit 1
fi

mkdir -p "$OUT"
for name in gpu-monitor.service gpu-monitor.crontab; do
  sed -e "s|__LYDIARD_ROOT__|$ROOT|g" \
      -e "s|__NODE_BIN__|$NODE_BIN|g" \
      -e "s|__NODE_DIR__|$(dirname "$NODE_BIN")|g" \
      "$ROOT/gpu-monitor/$name.template" > "$OUT/$name"
  echo "wrote $OUT/$name"
done
