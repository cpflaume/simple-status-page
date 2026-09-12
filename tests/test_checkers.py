"""Unit tests for the collector.

Network checks run against throwaway servers bound to 127.0.0.1 (loopback is
not proxied), so they are deterministic and need no internet access.
"""

from __future__ import annotations

import socket
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

# Import the collector package (collector/ is a sibling of tests/).
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "collector"))

import collect  # noqa: E402
from checkers import get_checker, known_types  # noqa: E402
from checkers.base import STATUS_DEGRADED, STATUS_DOWN, STATUS_UP  # noqa: E402


# --------------------------------------------------------------------------- #
# HTTP checker
# --------------------------------------------------------------------------- #
class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/ok":
            body = b'{"openapi":"3.0"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/boom":
            self.send_response(500)
            self.end_headers()
        elif self.path == "/slow":
            time.sleep(0.3)
            self.send_response(200)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):  # silence test output
        pass


@pytest.fixture(scope="module")
def http_base():
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    yield f"http://{host}:{port}"
    server.shutdown()


def test_http_up(http_base):
    r = get_checker("http").run({"url": f"{http_base}/ok"}, {})
    assert r.status == STATUS_UP
    assert r.latency_ms is not None


def test_http_body_contains_pass(http_base):
    r = get_checker("http").run(
        {"url": f"{http_base}/ok", "body_contains": "openapi"}, {}
    )
    assert r.status == STATUS_UP


def test_http_body_contains_fail(http_base):
    r = get_checker("http").run(
        {"url": f"{http_base}/ok", "body_contains": "nope"}, {}
    )
    assert r.status == STATUS_DOWN


def test_http_bad_status(http_base):
    r = get_checker("http").run({"url": f"{http_base}/boom"}, {})
    assert r.status == STATUS_DOWN
    assert "500" in r.detail


def test_http_accepts_expected_non_200(http_base):
    r = get_checker("http").run(
        {"url": f"{http_base}/boom", "expect_status": [500]}, {}
    )
    assert r.status == STATUS_UP


def test_http_degraded_when_slow(http_base):
    r = get_checker("http").run(
        {"url": f"{http_base}/slow", "degraded_latency_ms": 50}, {}
    )
    assert r.status == STATUS_DEGRADED


def test_http_connection_refused_is_down():
    # Nothing listening on this port -> connection refused -> down (not a crash).
    r = get_checker("http").run({"url": "http://127.0.0.1:1", "timeout": 2}, {})
    assert r.status == STATUS_DOWN


# --------------------------------------------------------------------------- #
# TCP checker
# --------------------------------------------------------------------------- #
def _banner_server(banner: bytes):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)

    def serve():
        try:
            conn, _ = srv.accept()
            if banner:
                conn.sendall(banner)
            time.sleep(0.05)
            conn.close()
        except OSError:
            pass

    threading.Thread(target=serve, daemon=True).start()
    return srv


def test_tcp_connect_ok():
    srv = _banner_server(b"")
    _, port = srv.getsockname()
    r = get_checker("tcp").run({"host": "127.0.0.1", "port": port}, {})
    srv.close()
    assert r.status == STATUS_UP


def test_tcp_banner_match():
    srv = _banner_server(b"220 mail.example ESMTP\r\n")
    _, port = srv.getsockname()
    r = get_checker("tcp").run(
        {"host": "127.0.0.1", "port": port, "expect_banner": "220"}, {}
    )
    srv.close()
    assert r.status == STATUS_UP


def test_tcp_banner_mismatch():
    srv = _banner_server(b"554 go away\r\n")
    _, port = srv.getsockname()
    r = get_checker("tcp").run(
        {"host": "127.0.0.1", "port": port, "expect_banner": "220"}, {}
    )
    srv.close()
    assert r.status == STATUS_DOWN


def test_tcp_refused_is_down():
    r = get_checker("tcp").run({"host": "127.0.0.1", "port": 1, "timeout": 2}, {})
    assert r.status == STATUS_DOWN


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #
def test_known_types():
    assert set(known_types()) >= {"http", "tcp"}


def test_unknown_type_raises():
    with pytest.raises(KeyError):
        get_checker("does-not-exist")


# --------------------------------------------------------------------------- #
# Aggregation / history logic
# --------------------------------------------------------------------------- #
def test_overall_status_rollup():
    assert collect.overall_status([STATUS_UP, STATUS_UP]) == "operational"
    assert collect.overall_status([STATUS_UP, STATUS_DEGRADED]) == "degraded"
    assert collect.overall_status([STATUS_UP, STATUS_DOWN]) == "partial_outage"
    assert collect.overall_status([STATUS_DOWN, STATUS_DOWN]) == "major_outage"
    assert collect.overall_status([]) == "operational"


def test_history_update_and_retention():
    from checkers.base import CheckResult

    now = datetime.now(timezone.utc).replace(microsecond=0)
    history = {"days": [], "samples": []}

    # Two probes today: one up, one down.
    history = collect.update_history(history, CheckResult(STATUS_UP, 10), now)
    history = collect.update_history(history, CheckResult(STATUS_DOWN, 12), now)
    assert len(history["days"]) == 1
    day = history["days"][0]
    assert day["total"] == 2 and day["down"] == 1
    assert collect.day_status(day) == "down"
    assert collect.day_uptime(day) == 50.0

    # A very old bucket must be pruned by retention.
    old = (now.date() - timedelta(days=collect.MAX_DAYS + 5)).isoformat()
    history["days"].insert(0, {"date": old, "up": 1, "degraded": 0, "down": 0, "total": 1})
    history = collect.update_history(history, CheckResult(STATUS_UP, 8), now)
    assert all(d["date"] != old for d in history["days"])


def test_sample_cap():
    from checkers.base import CheckResult

    now = datetime.now(timezone.utc).replace(microsecond=0)
    history = {"days": [], "samples": []}
    for _ in range(collect.MAX_SAMPLES + 50):
        history = collect.update_history(history, CheckResult(STATUS_UP, 5), now)
    assert len(history["samples"]) == collect.MAX_SAMPLES


def test_resolve_display_defaults():
    d = collect.resolve_display({})
    assert d == {"min_days": 30, "max_days": 90}
    # A bare/malformed block still yields the defaults.
    assert collect.resolve_display({"display": None}) == {"min_days": 30, "max_days": 90}


def test_resolve_display_overrides():
    d = collect.resolve_display({"display": {"min_days": 7, "max_days": 180}})
    assert d == {"min_days": 7, "max_days": 180}


def test_resolve_display_clamps_and_ignores_bad_values():
    # min never exceeds max.
    d = collect.resolve_display({"display": {"min_days": 200, "max_days": 90}})
    assert d == {"min_days": 90, "max_days": 90}
    # Non-positive / wrong-typed values fall back to the default for that key.
    d = collect.resolve_display({"display": {"min_days": 0, "max_days": "lots"}})
    assert d == {"min_days": 30, "max_days": 90}
    # Booleans are not accepted as day counts.
    d = collect.resolve_display({"display": {"min_days": True}})
    assert d["min_days"] == 30


def test_update_history_respects_custom_retention():
    from checkers.base import CheckResult

    now = datetime.now(timezone.utc).replace(microsecond=0)
    history = {"days": [], "samples": []}
    # A day 100 back is kept when retention is widened to 180, pruned at 90.
    old = (now.date() - timedelta(days=100)).isoformat()
    history["days"].append({"date": old, "up": 1, "degraded": 0, "down": 0, "total": 1})

    kept = collect.update_history(dict(history, days=list(history["days"])),
                                 CheckResult(STATUS_UP, 5), now, max_days=180)
    assert any(d["date"] == old for d in kept["days"])

    pruned = collect.update_history(dict(history, days=list(history["days"])),
                                    CheckResult(STATUS_UP, 5), now, max_days=90)
    assert all(d["date"] != old for d in pruned["days"])


def test_uptime_last_24h():
    now = datetime.now(timezone.utc).replace(microsecond=0)
    samples = [
        {"t": (now - timedelta(hours=1)).isoformat(), "s": STATUS_UP, "ms": 5},
        {"t": (now - timedelta(hours=2)).isoformat(), "s": STATUS_DOWN, "ms": 5},
        {"t": (now - timedelta(hours=48)).isoformat(), "s": STATUS_DOWN, "ms": 5},
    ]
    # Only the two within 24h count -> 1 down of 2 -> 50%.
    assert collect.uptime_last_24h(samples, now) == 50.0
