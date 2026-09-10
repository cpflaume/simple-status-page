"""Checker contract shared by every status source.

A *checker* turns one entry from ``config/services.yaml`` into a single
:class:`CheckResult`. Adding a new data source (Prometheus, a push endpoint, a
DNS probe, ...) means writing one ``Checker`` subclass and registering it in
``checkers/__init__.py`` — nothing else in the collector or the frontend
changes. That is the whole point of this indirection: the rest of the system
only ever sees the normalized :class:`CheckResult`.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone

# The three states every source normalizes to. Ordered worst-last so the
# frontend and the overall roll-up can compare severities.
STATUS_UP = "up"
STATUS_DEGRADED = "degraded"
STATUS_DOWN = "down"

# Severity ranking (higher = worse). Used to roll checks up into one overall
# banner and to pick the "worst" status of a day.
SEVERITY = {STATUS_UP: 0, STATUS_DEGRADED: 1, STATUS_DOWN: 2}


@dataclass
class CheckResult:
    """The normalized outcome of probing one target, once."""

    status: str
    latency_ms: int | None = None
    detail: str = ""
    checked_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
    )

    def as_sample(self) -> dict:
        """Compact form persisted in the rolling history (keep keys short —
        this is written on every run for every check)."""
        return {"t": self.checked_at, "s": self.status, "ms": self.latency_ms}


class Checker(ABC):
    """Base class for all status sources.

    Subclasses set :attr:`TYPE` (the value used in ``type:`` in the config) and
    implement :meth:`check`. They should *not* need to catch their own
    exceptions for reachability failures — :meth:`run` wraps :meth:`check` and
    converts any exception into a ``down`` result, so a misbehaving source can
    never crash the whole collector run.
    """

    #: The ``type:`` string this checker handles in ``config/services.yaml``.
    TYPE: str = ""

    @abstractmethod
    def check(self, check: dict, defaults: dict) -> CheckResult:
        """Probe the target described by ``check`` and return a result.

        ``check`` is the raw mapping from the config; ``defaults`` carries
        config-wide fallbacks (e.g. ``timeout``). Raise on failure — the
        wrapper turns that into a ``down`` result.
        """

    def run(self, check: dict, defaults: dict) -> CheckResult:
        """Call :meth:`check`, guaranteeing a :class:`CheckResult` is returned.

        Any unhandled exception becomes a ``down`` result whose ``detail``
        names the error, so one broken target degrades only its own tile.
        """
        started = time.monotonic()
        try:
            return self.check(check, defaults)
        except Exception as exc:  # noqa: BLE001 - deliberate catch-all
            elapsed = int((time.monotonic() - started) * 1000)
            return CheckResult(
                status=STATUS_DOWN,
                latency_ms=elapsed,
                detail=f"{type(exc).__name__}: {exc}",
            )
