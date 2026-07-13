# Gemini YouTube transcript collector

`scripts/gemini-youtube-transcripts.py` inventories every public item exposed by
a YouTube channel's Videos and Shorts tabs, groups each original-English caption
track into exact 30-second blocks, then asks Google Gemini to faithfully clean and
normalize one complete timestamped transcript per item. If a caption track is
unavailable, the collector falls back to direct Gemini video transcription.

The default target is Stephen Scullion's channel. As of 2026-07-13, discovery
returns 284 unique items: 235 standard videos with 58.14 hours of known runtime
and 49 Shorts whose durations are not included in YouTube's flat channel index.

## Outputs

The default output is `tmp/stephen-scullion-transcripts-cleaned/`, which is already
gitignored. It contains:

- `inventory.json` and `inventory.csv`: the current channel inventory;
- `manifest.json`: per-video status, errors, model, usage, and output paths;
- `transcripts/<VIDEO_ID>.md`: readable timestamped transcripts;
- `raw-responses/<VIDEO_ID>.json`: original Gemini responses for auditing.
- `source-captions/<VIDEO_ID>.en-orig.json3`: the timing/source scaffold used for
  independent coverage checks.
- `audit.json`: final coverage, finish-reason, file, and timestamp-integrity result;
- `index.md` and `corpus.jsonl`: browsable and machine-readable consolidated corpora.

Writes are atomic and the manifest is checkpointed after every video. A repeated
command skips `complete` and access-restricted `unavailable` items, and retries
incomplete or failed ones. The final audit reports accessible coverage separately
from members-only/private channel-index entries.

## Authentication

Create a Gemini API key in Google AI Studio. The script accepts
`GEMINI_API_KEY` (preferred) or `GOOGLE_API_KEY`, first from the environment and
then from the project's existing gitignored `.env`. It never writes or prints
the credential.

```bash
read -rsp 'Gemini API key: ' GEMINI_API_KEY
export GEMINI_API_KEY
```

For a run that Codex should continue in a later turn, add this line directly to
the existing `.env` in the editor instead. Do not paste the real key into chat:

```dotenv
GEMINI_API_KEY=<your Google AI Studio key>
```

## Commands

Refresh the inventory without making Gemini requests:

```bash
python3 scripts/gemini-youtube-transcripts.py --inventory-only
```

Validate one end-to-end transcript before starting the corpus:

```bash
python3 scripts/gemini-youtube-transcripts.py --limit 1
```

The default caption-cleaning path sends text rather than YouTube video input, so
Gemini's direct-YouTube eight-hour daily free-tier limit does not apply. To force
direct video transcription, use `--source video`; if using the free tier, leave
headroom and run a resumable daily batch:

```bash
python3 scripts/gemini-youtube-transcripts.py --source video --max-input-hours 7.5
```

Launch the full default job inside tmux because it is long-running:

```bash
mkdir -p progress/logs
tmux new -s scullion-transcripts
python3 scripts/gemini-youtube-transcripts.py 2>&1 | tee progress/logs/scullion-transcripts-cleaned.log
```

After detaching with `Ctrl-b d`, verify the process rather than relying on the
launch command alone:

```bash
tmux ls
tail -50 progress/logs/scullion-transcripts-cleaned.log
ps -eo pid,etime,cmd | rg 'gemini-youtube-transcripts'
```

The default model is `gemini-3.1-flash-lite`, selected after standard-video and
Short quality gates. Direct `gemini-3.5-flash` produced a strong benchmark but was
too capacity-bound for the corpus, while Google rejected `gemini-2.5-flash` for a
new user. To use another model or source mode, choose a new output directory so
incompatible transcripts cannot be mixed accidentally:

```bash
python3 scripts/gemini-youtube-transcripts.py \
  --model <MODEL_NAME> \
  --output tmp/stephen-scullion-transcripts-<MODEL_NAME>
```
