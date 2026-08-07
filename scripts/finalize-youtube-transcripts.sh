#!/usr/bin/env bash
# Waits for an in-progress transcript session to finish, then reruns the collector to fill any
# gaps and audits the result. Usage: scripts/finalize-youtube-transcripts.sh <channel-url>

set -u
set -o pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CHANNEL="${1:-${YOUTUBE_CHANNEL:-}}"
if [ -z "$CHANNEL" ]; then
  echo "Usage: scripts/finalize-youtube-transcripts.sh <channel-url>" >&2
  exit 2
fi

SESSION="${TRANSCRIPT_SESSION:-youtube-transcripts}"
LOG="progress/logs/${SESSION}.log"
mkdir -p progress/logs

while tmux has-session -t "$SESSION" 2>/dev/null; do
  sleep 30
done

bash -ic "python3 -B scripts/gemini-youtube-transcripts.py --channel '$CHANNEL'" \
  2>&1 | tee -a "$LOG"

python3 -B scripts/audit-youtube-transcripts.py \
  2>&1 | tee -a "$LOG"
