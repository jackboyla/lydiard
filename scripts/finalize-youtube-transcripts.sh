#!/usr/bin/env bash

set -u
set -o pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

while tmux has-session -t scullion-transcripts 2>/dev/null; do
  sleep 30
done

bash -ic 'python3 -B scripts/gemini-youtube-transcripts.py' \
  2>&1 | tee -a progress/logs/scullion-transcripts-cleaned.log

python3 -B scripts/audit-youtube-transcripts.py \
  2>&1 | tee -a progress/logs/scullion-transcripts-cleaned.log
