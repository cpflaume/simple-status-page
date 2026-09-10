"""TCP / SMTP checker — for services Caddy can't reverse-proxy.

Opens a TCP connection to ``host:port`` and, optionally, reads the server's
greeting and asserts it starts with ``expect_banner`` (e.g. ``220`` for SMTP).
This is the right abstraction for the typo-mail-responder (SMTP :25).

NOTE: GitHub-hosted runners block *outbound* port 25, so this check will fail
from a default runner. See the README ("SMTP / port 25") for the two supported
ways to run it: a self-hosted runner with port-25 egress, or a push-based
report. The check ships disabled in the config for that reason.
"""

from __future__ import annotations

import socket
import time

from .base import STATUS_DOWN, STATUS_UP, CheckResult, Checker


class TcpChecker(Checker):
    TYPE = "tcp"

    def check(self, check: dict, defaults: dict) -> CheckResult:
        host = check["host"]
        port = int(check["port"])
        timeout = check.get("timeout", defaults.get("timeout", 10))
        expect_banner = check.get("expect_banner")

        started = time.monotonic()
        with socket.create_connection((host, port), timeout=timeout) as sock:
            banner = ""
            if expect_banner:
                sock.settimeout(timeout)
                banner = sock.recv(256).decode("utf-8", "replace").strip()
            latency_ms = int((time.monotonic() - started) * 1000)

        if expect_banner and not banner.startswith(str(expect_banner)):
            return CheckResult(
                status=STATUS_DOWN,
                latency_ms=latency_ms,
                detail=f"unexpected banner: {banner[:60]!r}",
            )
        detail = f"connected {host}:{port}"
        if expect_banner:
            detail = f"banner {banner[:40]!r}"
        return CheckResult(status=STATUS_UP, latency_ms=latency_ms, detail=detail)
