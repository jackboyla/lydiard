#!/usr/bin/env python3
"""Create a resumable transcript corpus for a public YouTube channel with Gemini.

The script deliberately stores its corpus under tmp/ by default. The repository's
.gitignore already excludes that directory because transcripts can be large and
may not be appropriate source-control artifacts.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_MODEL = "gemini-3.1-flash-lite"
DEFAULT_OUTPUT = Path("tmp/youtube-transcripts-cleaned")
UNKNOWN_SHORT_SECONDS = 60
MANIFEST_VERSION = 1

TRANSCRIPT_PROMPT = """Produce a faithful, complete transcript of this video.

TRANSCRIPT CONTENT REQUIREMENTS:
- Transcribe every intelligible spoken word from beginning to end; do not summarize.
- Preserve meaningful repetitions, false starts, and changes of speaker.
- Do not invent words. Use [inaudible] when speech cannot be understood.
- Include speaker labels when the speaker can be distinguished; use neutral labels
  such as Speaker 1 when a name is not established by the video.
- Do not add commentary, analysis, an introduction, or a closing note.

STRICT OUTPUT CONTRACT:
- Return Markdown plain text, beginning directly with [00:00:00].
- EVERY non-empty transcript line must begin with a timestamp in [HH:MM:SS] format.
- Start a new transcript line at least once every 30 seconds and whenever the
  speaker changes. Never put more than 30 seconds of speech under one timestamp.
- Continue timestamped lines through the final spoken words. Do not place the
  entire transcript beneath a single opening timestamp.
- Before returning, silently verify that timestamps are chronological, that no
  adjacent timestamp gap exceeds 30 seconds, and that the final speech is included.
"""

CAPTION_PROMPT = """Clean and faithfully normalize the timestamped automatic
caption transcript below.

CONTENT REQUIREMENTS:
- Preserve every spoken word, repetition, false start, and meaningful interjection.
- Correct only obvious speech-recognition, spelling, capitalization, and punctuation
  errors. Do not paraphrase, summarize, shorten, embellish, or add commentary.
- Preserve [inaudible] and [no intelligible speech] markers where present.

STRICT OUTPUT CONTRACT:
- Return only the cleaned transcript lines, with no introduction or code fence.
- Return exactly one non-empty line for every input line, in the same order.
- Begin every output line with exactly the same [HH:MM:SS] timestamp as its input.
- Never add, remove, alter, duplicate, or reorder a timestamp.

TIMESTAMPED AUTOMATIC CAPTIONS:
"""


@dataclass(frozen=True)
class Video:
    video_id: str
    title: str
    url: str
    kind: str
    duration_seconds: int | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.video_id,
            "title": self.title,
            "url": self.url,
            "kind": self.kind,
            "duration_seconds": self.duration_seconds,
        }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def timestamp(seconds: int) -> str:
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"[{hours:02d}:{minutes:02d}:{seconds:02d}]"


def transcript_prompt(video: Video) -> str:
    if video.duration_seconds is None:
        return TRANSCRIPT_PROMPT
    allowed = " ".join(
        timestamp(seconds) for seconds in range(0, video.duration_seconds, 30)
    )
    duration = timestamp(video.duration_seconds).strip("[]")
    return (
        f"{TRANSCRIPT_PROMPT}\n"
        f"The source video duration is {duration}. Use only the following line-start "
        f"timestamps, each at most once and in this exact order:\n{allowed}\n"
        "Write exactly one non-empty transcript line for every listed 30-second "
        "interval. If an entire interval has no intelligible speech, write "
        "[no intelligible speech] after its timestamp. Never omit a listed timestamp "
        "and never invent an unlisted timestamp."
    )


def atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def yt_dlp_prefix() -> list[str]:
    configured = os.environ.get("YT_DLP")
    if configured:
        return [configured]
    installed = shutil.which("yt-dlp")
    if installed:
        return [installed]
    uvx = shutil.which("uvx")
    if uvx:
        return [uvx, "--python", sys.executable, "--from", "yt-dlp", "yt-dlp"]
    raise RuntimeError(
        "yt-dlp is required for channel discovery. Install it or install uv/uvx."
    )


def discover_videos(channel_url: str) -> list[Video]:
    projection = "%(.{id,title,duration,playlist_title,webpage_url})j"
    command = [
        *yt_dlp_prefix(),
        "--flat-playlist",
        "--no-warnings",
        "--print",
        projection,
        channel_url,
    ]
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"yt-dlp channel discovery failed: {message}")

    discovered: dict[str, Video] = {}
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        video_id = item.get("id")
        if not isinstance(video_id, str) or not video_id:
            continue
        playlist_title = str(item.get("playlist_title") or "")
        kind = "short" if playlist_title.endswith(" - Shorts") else "video"
        duration = item.get("duration")
        duration_seconds = round(duration) if isinstance(duration, (int, float)) else None
        default_url = f"https://www.youtube.com/watch?v={video_id}"
        discovered[video_id] = Video(
            video_id=video_id,
            title=str(item.get("title") or video_id),
            url=str(item.get("webpage_url") or default_url),
            kind=kind,
            duration_seconds=duration_seconds,
        )
    return list(discovered.values())


def caption_prompt(
    video: Video, output: Path
) -> tuple[str, list[int], Path]:
    captions_dir = output / "source-captions"
    captions_dir.mkdir(parents=True, exist_ok=True)
    caption_path = captions_dir / f"{video.video_id}.en-orig.json3"
    if not caption_path.exists():
        template = captions_dir / "%(id)s.%(ext)s"
        command = [
            *yt_dlp_prefix(),
            "--no-warnings",
            "--skip-download",
            "--write-auto-subs",
            "--sub-langs",
            "en-orig",
            "--sub-format",
            "json3",
            "-o",
            str(template),
            video.url,
        ]
        result = subprocess.run(command, check=False, capture_output=True, text=True)
        if result.returncode != 0 or not caption_path.exists():
            message = result.stderr.strip() or "English original captions unavailable"
            raise RuntimeError(message[:1000])

    data = json.loads(caption_path.read_text(encoding="utf-8"))
    events = [event for event in data.get("events", []) if event.get("segs")]
    if not events:
        raise RuntimeError("English original caption track contains no text events")
    last_end_seconds = max(
        (event.get("tStartMs", 0) + event.get("dDurationMs", 0)) / 1000
        for event in events
    )
    duration_seconds = video.duration_seconds or max(1, round(last_end_seconds))
    expected_stamps = list(range(0, duration_seconds, 30))
    buckets: dict[int, list[str]] = {stamp: [] for stamp in expected_stamps}
    for event in events:
        text = "".join(
            str(segment.get("utf8") or "") for segment in event.get("segs", [])
        )
        text = " ".join(text.replace("\n", " ").split())
        if not text:
            continue
        stamp = min(
            (int(event.get("tStartMs", 0) / 1000) // 30) * 30,
            expected_stamps[-1],
        )
        buckets[stamp].append(text)
    source_lines = [
        f"{timestamp(stamp)} "
        + (" ".join(buckets[stamp]) or "[no intelligible speech]")
        for stamp in expected_stamps
    ]
    return CAPTION_PROMPT + "\n".join(source_lines), expected_stamps, caption_path


def write_inventory(output: Path, channel_url: str, videos: list[Video]) -> None:
    known_seconds = sum(video.duration_seconds or 0 for video in videos)
    unknown_durations = sum(video.duration_seconds is None for video in videos)
    inventory = {
        "generated_at": utc_now(),
        "channel_url": channel_url,
        "video_count": len(videos),
        "known_duration_seconds": known_seconds,
        "unknown_duration_count": unknown_durations,
        "videos": [video.as_dict() for video in videos],
    }
    atomic_json_write(output / "inventory.json", inventory)

    csv_path = output / "inventory.csv"
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = csv_path.with_suffix(".csv.tmp")
    with temporary.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["id", "kind", "duration_seconds", "title", "url"],
        )
        writer.writeheader()
        writer.writerows(video.as_dict() for video in videos)
    temporary.replace(csv_path)


def load_manifest(
    output: Path, channel_url: str, model: str, source_mode: str
) -> dict[str, Any]:
    path = output / "manifest.json"
    if path.exists():
        manifest = json.loads(path.read_text(encoding="utf-8"))
        previous_model = manifest.get("model")
        if previous_model and previous_model != model:
            raise RuntimeError(
                f"Existing manifest uses {previous_model!r}, not {model!r}. "
                "Use a different --output directory to change models."
            )
        previous_source = manifest.get("source_mode")
        if previous_source and previous_source != source_mode:
            raise RuntimeError(
                f"Existing manifest uses source mode {previous_source!r}, not "
                f"{source_mode!r}. Use a different --output directory."
            )
        return manifest
    return {
        "version": MANIFEST_VERSION,
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "channel_url": channel_url,
        "model": model,
        "source_mode": source_mode,
        "items": {},
    }


def save_manifest(output: Path, manifest: dict[str, Any]) -> None:
    manifest["updated_at"] = utc_now()
    atomic_json_write(output / "manifest.json", manifest)


def dotenv_value(path: Path, names: tuple[str, ...]) -> str | None:
    if not path.exists():
        return None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() not in names:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if value:
            return value
    return None


def api_key() -> str:
    names = ("GEMINI_API_KEY", "GOOGLE_API_KEY")
    value = (
        os.environ.get(names[0])
        or os.environ.get(names[1])
        or dotenv_value(Path(".env"), names)
    )
    if not value:
        raise RuntimeError(
            "Set GEMINI_API_KEY (preferred) or GOOGLE_API_KEY in the environment "
            "or the project's gitignored .env before transcription."
        )
    return value


def response_text(response: dict[str, Any]) -> str:
    candidates = response.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        block_reason = response.get("promptFeedback", {}).get("blockReason")
        suffix = f" (block reason: {block_reason})" if block_reason else ""
        raise RuntimeError(f"Gemini returned no transcript candidate{suffix}")

    candidate = candidates[0]
    finish_reason = candidate.get("finishReason")
    if finish_reason not in (None, "STOP"):
        raise RuntimeError(f"Gemini response was incomplete: {finish_reason}")
    parts = candidate.get("content", {}).get("parts", [])
    text = "".join(part.get("text", "") for part in parts if isinstance(part, dict))
    if not text.strip():
        raise RuntimeError("Gemini returned an empty transcript")
    return text.strip()


def validate_transcript(
    video: Video,
    transcript: str,
    expected_stamps: list[int] | None = None,
) -> dict[str, Any]:
    import re

    lines = [line for line in transcript.splitlines() if line.strip()]
    stamps: list[int] = []
    for line in lines:
        match = re.match(r"^\[(\d{2}):(\d{2}):(\d{2})\]", line)
        if not match:
            raise RuntimeError("Gemini returned a non-empty line without a timestamp")
        hours, minutes, seconds = (int(value) for value in match.groups())
        if minutes > 59 or seconds > 59:
            raise RuntimeError(f"Gemini returned an invalid timestamp: {match.group(0)}")
        stamps.append(hours * 3600 + minutes * 60 + seconds)

    if not stamps or stamps[0] != 0:
        raise RuntimeError("Gemini transcript must begin at [00:00:00]")
    if stamps != sorted(set(stamps)):
        raise RuntimeError("Gemini timestamps are duplicated or not chronological")
    gaps = [later - earlier for earlier, later in zip(stamps, stamps[1:])]
    if gaps and max(gaps) > 30:
        raise RuntimeError("Gemini transcript has a timestamp gap greater than 30 seconds")
    if expected_stamps is None and video.duration_seconds is not None:
        expected_stamps = list(range(0, video.duration_seconds, 30))
    if expected_stamps is not None:
        if stamps != expected_stamps:
            raise RuntimeError(
                "Gemini timestamps do not match the required 30-second source timeline"
            )
    return {
        "timestamp_count": len(stamps),
        "first_timestamp_seconds": stamps[0],
        "last_timestamp_seconds": stamps[-1],
        "largest_timestamp_gap_seconds": max(gaps) if gaps else 0,
    }


def repair_transcript_timestamps(
    transcript: str,
    expected_stamps: list[int] | None,
) -> tuple[str, dict[str, Any]]:
    import re

    parsed: list[tuple[int, str]] = []
    for line in (line for line in transcript.splitlines() if line.strip()):
        match = re.match(r"^\[(\d{2}):(\d{2}):(\d{2})\]\s*(.*)$", line)
        if not match:
            raise RuntimeError("Cannot repair a transcript line without a timestamp")
        hours, minutes, seconds = (int(value) for value in match.groups()[:3])
        parsed.append((hours * 3600 + minutes * 60 + seconds, match.group(4).strip()))
    if not parsed:
        raise RuntimeError("Cannot repair an empty transcript")

    if expected_stamps:
        buckets: dict[int, list[str]] = {stamp: [] for stamp in expected_stamps}
        for stamp, content in parsed:
            nearest = min(expected_stamps, key=lambda candidate: abs(candidate - stamp))
            if content:
                buckets[nearest].append(content)
        repaired_lines = [
            f"{timestamp(stamp)} "
            + (" ".join(buckets[stamp]) or "[no intelligible speech]")
            for stamp in expected_stamps
        ]
        repaired_stamps = expected_stamps
    else:
        buckets: dict[int, list[str]] = {}
        ordered_stamps: list[int] = []
        for index, (stamp, content) in enumerate(parsed):
            if index == 0:
                stamp = 0
            if stamp not in buckets:
                ordered_stamps.append(stamp)
                buckets[stamp] = []
            if content:
                buckets[stamp].append(content)
        ordered_stamps.sort()
        repaired_lines = [
            f"{timestamp(stamp)} "
            + (" ".join(buckets[stamp]) or "[no intelligible speech]")
            for stamp in ordered_stamps
        ]
        repaired_stamps = ordered_stamps

    return "\n".join(repaired_lines), {
        "applied": True,
        "original_line_count": len(parsed),
        "repaired_line_count": len(repaired_lines),
        "repaired_timestamp_count": len(repaired_stamps),
    }


def gemini_request(
    key: str,
    model: str,
    prompt: str,
    video_url: str | None,
    timeout_seconds: int,
) -> dict[str, Any]:
    encoded_model = urllib.parse.quote(model, safe="-._")
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{encoded_model}:generateContent"
    )
    parts: list[dict[str, Any]] = []
    if video_url is not None:
        parts.append({"fileData": {"fileUri": video_url}})
    parts.append({"text": prompt})
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": parts,
            }
        ],
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": 65536,
        },
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as result:
            return json.load(result)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise GeminiHttpError(error.code, body) from error


class GeminiHttpError(RuntimeError):
    def __init__(self, status: int, body: str):
        self.status = status
        try:
            parsed = json.loads(body)
            message = parsed.get("error", {}).get("message") or body
        except json.JSONDecodeError:
            message = body
        super().__init__(f"Gemini HTTP {status}: {message[:1000]}")


class UnavailableVideoError(RuntimeError):
    """The channel index exposes a video that this account cannot access."""


def is_access_restricted(error: Exception) -> bool:
    message = str(error).lower()
    markers = (
        "members-only",
        "join this channel",
        "private video",
        "video is private",
        "sign in to confirm your age",
        "not available in your country",
    )
    return any(marker in message for marker in markers)


def request_with_retries(
    key: str,
    model: str,
    prompt: str,
    video_url: str | None,
    timeout_seconds: int,
    retries: int,
) -> tuple[dict[str, Any], int]:
    for attempt in range(1, retries + 2):
        try:
            return gemini_request(
                key, model, prompt, video_url, timeout_seconds
            ), attempt
        except (GeminiHttpError, urllib.error.URLError, TimeoutError) as error:
            retryable = not isinstance(error, GeminiHttpError) or error.status in {
                408,
                409,
                429,
                500,
                502,
                503,
                504,
            }
            if not retryable or attempt > retries:
                raise
            delay = min(60, (2 ** (attempt - 1)) + random.random())
            print(
                f"  retry {attempt}/{retries} after {delay:.1f}s: {error}",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(delay)
    raise AssertionError("unreachable")


def yaml_value(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def transcript_document(
    video: Video, model: str, source_method: str, transcript: str
) -> str:
    duration = "null" if video.duration_seconds is None else str(video.duration_seconds)
    return (
        "---\n"
        f"video_id: {yaml_value(video.video_id)}\n"
        f"title: {yaml_value(video.title)}\n"
        f"url: {yaml_value(video.url)}\n"
        f"kind: {yaml_value(video.kind)}\n"
        f"duration_seconds: {duration}\n"
        f"model: {yaml_value(model)}\n"
        f"source_method: {yaml_value(source_method)}\n"
        f"generated_at: {yaml_value(utc_now())}\n"
        "---\n\n"
        f"# {video.title}\n\n"
        f"{transcript}\n"
    )


def estimated_seconds(video: Video) -> int:
    return video.duration_seconds or UNKNOWN_SHORT_SECONDS


def select_pending(
    videos: list[Video],
    manifest: dict[str, Any],
    limit: int | None,
    max_input_hours: float | None,
) -> list[Video]:
    selected: list[Video] = []
    selected_seconds = 0
    max_seconds = None if max_input_hours is None else round(max_input_hours * 3600)
    items = manifest.setdefault("items", {})
    for video in videos:
        if items.get(video.video_id, {}).get("status") in {"complete", "unavailable"}:
            continue
        video_seconds = estimated_seconds(video)
        if max_seconds is not None and selected_seconds + video_seconds > max_seconds:
            continue
        selected.append(video)
        selected_seconds += video_seconds
        if limit is not None and len(selected) >= limit:
            break
    return selected


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", required=True, help="Channel URL, e.g. https://www.youtube.com/@handle")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument(
        "--source",
        choices=("captions", "video"),
        default="captions",
        help="clean YouTube captions with Gemini, or transcribe video directly",
    )
    parser.add_argument(
        "--inventory-only",
        action="store_true",
        help="discover the channel and write inventory files without calling Gemini",
    )
    parser.add_argument("--limit", type=int, help="maximum pending videos this run")
    parser.add_argument(
        "--max-input-hours",
        type=float,
        help="cap estimated video hours selected for this run (Shorts count as 60s)",
    )
    parser.add_argument("--delay", type=float, default=1.0)
    parser.add_argument("--retries", type=int, default=5)
    parser.add_argument("--timeout", type=int, default=180)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.limit is not None and args.limit < 1:
        raise RuntimeError("--limit must be at least 1")
    if args.max_input_hours is not None and args.max_input_hours <= 0:
        raise RuntimeError("--max-input-hours must be positive")

    args.output.mkdir(parents=True, exist_ok=True)
    print(f"Discovering {args.channel} ...", flush=True)
    videos = discover_videos(args.channel)
    if not videos:
        raise RuntimeError("Channel discovery returned no public videos")
    write_inventory(args.output, args.channel, videos)

    standard_count = sum(video.kind == "video" for video in videos)
    short_count = sum(video.kind == "short" for video in videos)
    known_hours = sum(video.duration_seconds or 0 for video in videos) / 3600
    print(
        f"Discovered {len(videos)} items: {standard_count} videos, {short_count} "
        f"Shorts, {known_hours:.2f} known hours.",
        flush=True,
    )
    if args.inventory_only:
        print(f"Inventory written to {args.output}", flush=True)
        return 0

    key = api_key()
    manifest = load_manifest(args.output, args.channel, args.model, args.source)
    pending = select_pending(videos, manifest, args.limit, args.max_input_hours)
    completed = sum(
        item.get("status") == "complete"
        for item in manifest.get("items", {}).values()
    )
    print(
        f"Already complete: {completed}; selected this run: {len(pending)}.",
        flush=True,
    )
    if not pending:
        save_manifest(args.output, manifest)
        return 0

    transcripts_dir = args.output / "transcripts"
    raw_dir = args.output / "raw-responses"
    transcripts_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)

    for index, video in enumerate(pending, start=1):
        print(
            f"[{index}/{len(pending)}] {video.video_id} — {video.title}",
            flush=True,
        )
        started_at = utc_now()
        raw_path: Path | None = None
        caption_path: Path | None = None
        expected_stamps: list[int] | None = None
        source_method = "gemini_video"
        try:
            if args.source == "captions":
                try:
                    prompt, expected_stamps, caption_path = caption_prompt(
                        video, args.output
                    )
                    video_url = None
                    source_method = "youtube_captions_cleaned_by_gemini"
                except Exception as caption_error:
                    if is_access_restricted(caption_error):
                        raise UnavailableVideoError(str(caption_error)) from caption_error
                    print(
                        f"  captions unavailable; falling back to video: {caption_error}",
                        file=sys.stderr,
                        flush=True,
                    )
                    prompt = transcript_prompt(video)
                    video_url = video.url
                    source_method = "gemini_video_fallback"
            else:
                prompt = transcript_prompt(video)
                video_url = video.url
            response, attempts = request_with_retries(
                key,
                args.model,
                prompt,
                video_url,
                timeout_seconds=args.timeout,
                retries=args.retries,
            )
            raw_path = raw_dir / f"{video.video_id}.json"
            atomic_json_write(raw_path, response)
            transcript = response_text(response)
            transcript_repair: dict[str, Any] | None = None
            try:
                transcript_validation = validate_transcript(
                    video, transcript, expected_stamps
                )
            except RuntimeError as validation_error:
                transcript, transcript_repair = repair_transcript_timestamps(
                    transcript, expected_stamps
                )
                transcript_repair["original_validation_error"] = str(validation_error)
                transcript_validation = validate_transcript(
                    video, transcript, expected_stamps
                )
            transcript_path = transcripts_dir / f"{video.video_id}.md"
            temporary = transcript_path.with_suffix(".md.tmp")
            temporary.write_text(
                transcript_document(video, args.model, source_method, transcript),
                encoding="utf-8",
            )
            temporary.replace(transcript_path)
            manifest["items"][video.video_id] = {
                **video.as_dict(),
                "status": "complete",
                "started_at": started_at,
                "completed_at": utc_now(),
                "attempts": attempts,
                "source_method": source_method,
                "source_caption_path": str(caption_path) if caption_path else None,
                "transcript_path": str(transcript_path),
                "raw_response_path": str(raw_path),
                "characters": len(transcript),
                "transcript_validation": transcript_validation,
                "transcript_repair": transcript_repair,
                "usage_metadata": response.get("usageMetadata"),
            }
            print(f"  complete: {len(transcript):,} characters", flush=True)
        except Exception as error:  # keep the channel run resumable after one failure
            unavailable = isinstance(error, UnavailableVideoError) or (
                isinstance(error, GeminiHttpError)
                and error.status == 403
                and source_method == "gemini_video_fallback"
            )
            manifest["items"][video.video_id] = {
                **video.as_dict(),
                "status": "unavailable" if unavailable else "failed",
                "started_at": started_at,
                "unavailable_at" if unavailable else "failed_at": utc_now(),
                "source_method": source_method,
                "source_caption_path": str(caption_path) if caption_path else None,
                "raw_response_path": str(raw_path) if raw_path else None,
                "error": str(error),
            }
            label = "unavailable" if unavailable else "failed"
            print(f"  {label}: {error}", file=sys.stderr, flush=True)
            if (
                not unavailable
                and isinstance(error, GeminiHttpError)
                and error.status in {401, 403, 404, 429}
            ):
                print(
                    "  stopping this run because authentication, model access, or "
                    "quota must be resolved before more requests",
                    file=sys.stderr,
                    flush=True,
                )
                break
        finally:
            save_manifest(args.output, manifest)
        if index < len(pending) and args.delay > 0:
            time.sleep(args.delay)

    complete = sum(
        item.get("status") == "complete" for item in manifest["items"].values()
    )
    failed = sum(item.get("status") == "failed" for item in manifest["items"].values())
    unavailable = sum(
        item.get("status") == "unavailable" for item in manifest["items"].values()
    )
    print(
        f"Run finished. Complete: {complete}/{len(videos)}; unavailable: "
        f"{unavailable}; failed: {failed}. "
        f"Manifest: {args.output / 'manifest.json'}",
        flush=True,
    )
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted; completed items remain checkpointed.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
