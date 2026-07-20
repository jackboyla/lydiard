#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="/path/to/lydiard"
readonly NODE="/usr/local/bin/node"
readonly SERVER="$ROOT/gpu-monitor/server.mjs"
readonly LOG="$ROOT/progress/logs/gpu-monitor.log"
readonly PID_FILE="$ROOT/.local/gpu-monitor.pid"
readonly LOCK_FILE="/tmp/lydiard-gpu-monitor-watchdog.lock"
readonly HEALTH_URL="http://127.0.0.1:8789/healthz"

umask 077
exec 9>"$LOCK_FILE"
/usr/bin/flock -n 9 || exit 0

if /usr/bin/curl --noproxy '*' --fail --silent --show-error --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
  exit 0
fi

if [[ -f "$PID_FILE" ]]; then
  previous_pid="$(<"$PID_FILE")"
  if [[ "$previous_pid" =~ ^[0-9]+$ ]] && [[ -r "/proc/$previous_pid/cmdline" ]]; then
    previous_command="$(tr '\0' ' ' < "/proc/$previous_pid/cmdline")"
    if [[ "$previous_command" == *"$SERVER"* ]]; then
      kill -TERM "$previous_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
fi

printf '\n[%s] watchdog starting GPU monitor\n' "$(date -Is)" >> "$LOG"
nohup /usr/bin/setsid "$NODE" "$SERVER" >> "$LOG" 2>&1 < /dev/null &
monitor_pid=$!
printf '%s\n' "$monitor_pid" > "$PID_FILE"

for _ in 1 2 3 4 5; do
  if /usr/bin/curl --noproxy '*' --fail --silent --show-error --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

printf '[%s] watchdog launch did not become healthy (pid %s)\n' "$(date -Is)" "$monitor_pid" >> "$LOG"
exit 1
