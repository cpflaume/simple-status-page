#!/usr/bin/env python3
"""Status collector.

Reads ``config/services.yaml``, runs every enabled check through its registered
:class:`~checkers.base.Checker`, and updates the JSON files the static page
reads:

* ``data/summary.json``          — the latest snapshot (what the page shows first).
* ``data/history/<id>.json``     — per-check rolling history (the 90-day bars).

Run it locally:  ``python collector/collect.py``
It is also what the GitHub Actions workflow runs on a schedule.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

# Make ``import checkers`` work regardless of the current working directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from checkers import get_checker  # noqa: E402
from checkers.base import SEVERITY, STATUS_DOWN, STATUS_UP  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "services.yaml"
DATA_DIR = ROOT / "data"
HISTORY_DIR = DATA_DIR / "history"

# Retention: how much history to keep. Kept small so the committed data files
# (and thus git history / the deployed artifact) stay tiny.
MAX_DAYS = 90       # daily uptime buckets -> the 90-day bar
MAX_SAMPLES = 200   # recent raw samples -> latency sparkline / recent timeline

# Overall banner wording, indexed the same way as check severity.
OVERALL_TEXT = {
    "operational": "All systems operational",
    "degraded": "Degraded performance",
    "partial_outage": "Partial system outage",
    "major_outage": "Major system outage",
}


def load_config() -> dict:
    with CONFIG_PATH.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def iter_checks(config: dict):
    """Yield ``(group_name, check)`` for every enabled check."""
    for group in config.get("groups", []):
        for check in group.get("checks", []):
            if check.get("enabled", True):
                yield group.get("name", ""), check


def load_history(check_id: str) -> dict:
    path = HISTORY_DIR / f"{check_id}.json"
    if path.exists():
        with path.open(encoding="utf-8") as fh:
            return json.load(fh)
    return {"days": [], "samples": []}


def save_history(check_id: str, history: dict) -> None:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    path = HISTORY_DIR / f"{check_id}.json"
    with path.open("w", encoding="utf-8") as fh:
        json.dump(history, fh, separators=(",", ":"))
        fh.write("\n")


def update_history(history: dict, result, now: datetime) -> dict:
    """Fold one result into the rolling history and prune to retention."""
    today = now.date().isoformat()

    # --- daily buckets (worst-status + counts per calendar day, UTC) ---
    days = {d["date"]: d for d in history.get("days", [])}
    bucket = days.setdefault(
        today, {"date": today, "up": 0, "degraded": 0, "down": 0, "total": 0}
    )
    bucket[result.status] = bucket.get(result.status, 0) + 1
    bucket["total"] += 1

    cutoff = (now.date() - timedelta(days=MAX_DAYS - 1)).isoformat()
    history["days"] = sorted(
        (d for d in days.values() if d["date"] >= cutoff), key=lambda d: d["date"]
    )

    # --- recent raw samples (for latency / recent timeline) ---
    samples = history.get("samples", [])
    samples.append(result.as_sample())
    history["samples"] = samples[-MAX_SAMPLES:]
    return history


def day_uptime(day: dict) -> float:
    total = day.get("total", 0)
    if not total:
        return 0.0
    # Availability = anything that is not a hard "down". Degraded still serves.
    return round(100.0 * (total - day.get("down", 0)) / total, 3)


def day_status(day: dict) -> str:
    """Colour for one cell of the 90-day bar."""
    if day.get("down"):
        return "down"
    if day.get("degraded"):
        return "degraded"
    if day.get("total"):
        return "up"
    return "nodata"


def uptime_over_days(days: list[dict]) -> float | None:
    total = sum(d.get("total", 0) for d in days)
    if not total:
        return None
    down = sum(d.get("down", 0) for d in days)
    return round(100.0 * (total - down) / total, 3)


def uptime_last_24h(samples: list[dict], now: datetime) -> float | None:
    cutoff = (now - timedelta(hours=24)).isoformat()
    recent = [s for s in samples if s.get("t", "") >= cutoff]
    if not recent:
        return None
    down = sum(1 for s in recent if s.get("s") == STATUS_DOWN)
    return round(100.0 * (len(recent) - down) / len(recent), 3)


def overall_status(statuses: list[str]) -> str:
    """Roll individual check statuses up into one banner state."""
    if not statuses:
        return "operational"
    worst = max(SEVERITY.get(s, 0) for s in statuses)
    down_count = sum(1 for s in statuses if s == STATUS_DOWN)
    if worst == SEVERITY[STATUS_DOWN]:
        # One outage is "partial"; everything down is "major".
        return "major_outage" if down_count == len(statuses) else "partial_outage"
    if worst == SEVERITY["degraded"]:
        return "degraded"
    return "operational"


def main() -> int:
    config = load_config()
    now = datetime.now(timezone.utc).replace(microsecond=0)

    checks_out: list[dict] = []
    for group_name, check in iter_checks(config):
        checker = get_checker(check["type"])
        result = checker.run(check, config.get("defaults", {}))

        history = update_history(load_history(check["id"]), result, now)
        save_history(check["id"], history)

        checks_out.append(
            {
                "id": check["id"],
                "name": check.get("name", check["id"]),
                "group": group_name,
                "type": check["type"],
                "url": check.get("url"),
                "status": result.status,
                "latency_ms": result.latency_ms,
                "detail": result.detail,
                "checked_at": result.checked_at,
                "uptime_24h": uptime_last_24h(history["samples"], now),
                "uptime_90d": uptime_over_days(history["days"]),
                "days": [
                    {"date": d["date"], "status": day_status(d), "uptime": day_uptime(d)}
                    for d in history["days"]
                ],
            }
        )

    state = overall_status([c["status"] for c in checks_out])
    summary = {
        "name": config.get("name", "Status"),
        "description": config.get("description", ""),
        "generated_at": now.isoformat(),
        "overall_status": state,
        "overall_text": OVERALL_TEXT[state],
        "checks": checks_out,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with (DATA_DIR / "summary.json").open("w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
        fh.write("\n")

    up = sum(1 for c in checks_out if c["status"] == STATUS_UP)
    print(f"{state}: {up}/{len(checks_out)} checks up @ {now.isoformat()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
