"""HTTP(S) checker — the workhorse for web services.

Black-box probe of a public URL: this measures what a real visitor experiences,
which is exactly what a *public* status page should report. For the Spring Boot
apps we hit ``/v3/api-docs`` (public Springdoc OpenAPI JSON) to prove the API
process is alive, and ``/`` to prove a frontend is served.
"""

from __future__ import annotations

import time
import urllib.error
import urllib.request

from .base import STATUS_DEGRADED, STATUS_DOWN, STATUS_UP, CheckResult, Checker


class HttpChecker(Checker):
    TYPE = "http"

    def check(self, check: dict, defaults: dict) -> CheckResult:
        url = check["url"]
        method = check.get("method", "GET").upper()
        timeout = check.get("timeout", defaults.get("timeout", 10))
        # Accept a single int or a list of acceptable status codes.
        expect = check.get("expect_status", [200])
        if isinstance(expect, int):
            expect = [expect]
        degraded_ms = check.get(
            "degraded_latency_ms", defaults.get("degraded_latency_ms", 2000)
        )
        body_contains = check.get("body_contains")

        request = urllib.request.Request(
            url,
            method=method,
            headers={"User-Agent": "copf-demo-status/1 (+https://status.copf-demo.de)"},
        )

        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=timeout) as resp:
                code = resp.status
                # Only read the body when we actually need to inspect it.
                body = resp.read().decode("utf-8", "replace") if body_contains else ""
        except urllib.error.HTTPError as exc:
            # The server answered, just not with a success code — that is a
            # real signal, so report the code rather than a bare exception.
            code = exc.code
            body = ""
        latency_ms = int((time.monotonic() - started) * 1000)

        if code not in expect:
            return CheckResult(
                status=STATUS_DOWN,
                latency_ms=latency_ms,
                detail=f"HTTP {code} (expected {'/'.join(map(str, expect))})",
            )
        if body_contains and body_contains not in body:
            return CheckResult(
                status=STATUS_DOWN,
                latency_ms=latency_ms,
                detail=f"body did not contain {body_contains!r}",
            )
        if latency_ms > degraded_ms:
            return CheckResult(
                status=STATUS_DEGRADED,
                latency_ms=latency_ms,
                detail=f"slow: {latency_ms} ms > {degraded_ms} ms",
            )
        return CheckResult(status=STATUS_UP, latency_ms=latency_ms, detail=f"HTTP {code}")
