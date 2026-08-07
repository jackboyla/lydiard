#!/usr/bin/env python3
"""Audit a completed Gemini transcript corpus and build consolidated indexes."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_OUTPUT = Path("tmp/youtube-transcripts-cleaned")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def atomic_text_write(path: Path, text: str) -> None:
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def atomic_json_write(path: Path, value: Any) -> None:
    atomic_text_write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def transcript_body(document: str) -> str:
    body = document.split("---", 2)[-1]
    return re.sub(r"^\s*#.*?\n", "", body, count=1).strip()


def timestamps(body: str) -> list[int]:
    values = []
    for hours, minutes, seconds in re.findall(
        r"^\[(\d{2}):(\d{2}):(\d{2})\]", body, re.MULTILINE
    ):
        values.append(int(hours) * 3600 + int(minutes) * 60 + int(seconds))
    return values


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    inventory = json.loads((args.output / "inventory.json").read_text(encoding="utf-8"))
    manifest = json.loads((args.output / "manifest.json").read_text(encoding="utf-8"))
    videos = inventory.get("videos", [])
    items = manifest.get("items", {})
    issues: list[dict[str, str]] = []
    corpus_records: list[dict[str, Any]] = []
    index_rows: list[str] = []

    complete_count = 0
    failed_count = 0
    unavailable_count = 0
    total_characters = 0
    total_output_tokens = 0
    source_methods: dict[str, int] = {}

    for video in videos:
        video_id = video["id"]
        item = items.get(video_id)
        if not item:
            issues.append({"id": video_id, "issue": "missing manifest item"})
            index_rows.append(f"| `{video_id}` | pending | {video['title']} |\n")
            continue
        status = item.get("status")
        if status == "failed":
            failed_count += 1
            issues.append({"id": video_id, "issue": item.get("error", "failed")})
            index_rows.append(f"| `{video_id}` | failed | {video['title']} |\n")
            continue
        if status == "unavailable":
            unavailable_count += 1
            index_rows.append(f"| `{video_id}` | unavailable | {video['title']} |\n")
            continue
        if status != "complete":
            issues.append({"id": video_id, "issue": f"unexpected status: {status}"})
            continue

        complete_count += 1
        source_method = str(item.get("source_method") or "unknown")
        source_methods[source_method] = source_methods.get(source_method, 0) + 1
        transcript_path = Path(item.get("transcript_path", ""))
        raw_path = Path(item.get("raw_response_path", ""))
        if not transcript_path.exists():
            issues.append({"id": video_id, "issue": "missing transcript file"})
            continue
        if not raw_path.exists():
            issues.append({"id": video_id, "issue": "missing raw response file"})
            continue

        document = transcript_path.read_text(encoding="utf-8")
        body = transcript_body(document)
        nonempty_lines = [line for line in body.splitlines() if line.strip()]
        stamps = timestamps(body)
        validation = item.get("transcript_validation") or {}
        if len(stamps) != len(nonempty_lines):
            issues.append({"id": video_id, "issue": "non-timestamped transcript line"})
        if stamps != sorted(set(stamps)):
            issues.append({"id": video_id, "issue": "non-monotonic timestamps"})
        if len(stamps) != validation.get("timestamp_count"):
            issues.append({"id": video_id, "issue": "timestamp count mismatch"})

        raw = json.loads(raw_path.read_text(encoding="utf-8"))
        candidates = raw.get("candidates") or []
        finish_reason = candidates[0].get("finishReason") if candidates else None
        if finish_reason != "STOP":
            issues.append({"id": video_id, "issue": f"finish reason: {finish_reason}"})
        usage = raw.get("usageMetadata") or {}
        total_output_tokens += int(usage.get("candidatesTokenCount") or 0)
        total_characters += len(body)
        relative_path = transcript_path.relative_to(args.output)
        index_rows.append(
            f"| [`{video_id}`]({relative_path.as_posix()}) | complete | {video['title']} |\n"
        )
        corpus_records.append(
            {
                **video,
                "model": manifest.get("model"),
                "source_method": source_method,
                "transcript": body,
            }
        )

    expected_count = len(videos)
    audit = {
        "generated_at": utc_now(),
        "output": str(args.output),
        "expected_count": expected_count,
        "complete_count": complete_count,
        "failed_count": failed_count,
        "unavailable_count": unavailable_count,
        "accessible_expected_count": expected_count - unavailable_count,
        "missing_or_invalid_count": len(issues),
        "source_methods": source_methods,
        "total_characters": total_characters,
        "total_output_tokens": total_output_tokens,
        "issues": issues,
        "passed": (
            complete_count + unavailable_count == expected_count
            and failed_count == 0
            and not issues
        ),
    }
    atomic_json_write(args.output / "audit.json", audit)
    index = (
        "# Transcript corpus\n\n"
        f"Generated: {audit['generated_at']}\n\n"
        f"Accessible coverage: {complete_count}/{expected_count - unavailable_count}; "
        f"unavailable: {unavailable_count}; failures: {failed_count}; integrity "
        f"issues: {len(issues)}.\n\n"
        "| Video ID | Status | Title |\n"
        "|---|---|---|\n"
        + "".join(index_rows)
    )
    atomic_text_write(args.output / "index.md", index)
    jsonl = "".join(
        json.dumps(record, ensure_ascii=False) + "\n" for record in corpus_records
    )
    atomic_text_write(args.output / "corpus.jsonl", jsonl)
    print(json.dumps(audit, ensure_ascii=False, indent=2))
    return 0 if audit["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
