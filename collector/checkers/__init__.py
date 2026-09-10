"""Checker registry.

To add a new status source: create ``checkers/<name>_checker.py`` with a
:class:`~checkers.base.Checker` subclass, import it here, and add it to
``_CHECKERS``. The collector and the frontend need no changes — they only ever
see the normalized :class:`~checkers.base.CheckResult`.
"""

from __future__ import annotations

from .base import CheckResult, Checker  # re-exported for convenience
from .http_checker import HttpChecker
from .tcp_checker import TcpChecker

# type string -> Checker instance
_CHECKERS: dict[str, Checker] = {
    c.TYPE: c() for c in (HttpChecker, TcpChecker)
}


def get_checker(check_type: str) -> Checker:
    """Return the checker registered for ``check_type`` or raise ``KeyError``."""
    try:
        return _CHECKERS[check_type]
    except KeyError:
        known = ", ".join(sorted(_CHECKERS)) or "(none)"
        raise KeyError(
            f"unknown check type {check_type!r}; registered types: {known}"
        ) from None


def known_types() -> list[str]:
    return sorted(_CHECKERS)


__all__ = ["CheckResult", "Checker", "get_checker", "known_types"]
