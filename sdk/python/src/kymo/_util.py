"""Small internal helpers: env parsing and rate-limited warnings."""

from __future__ import annotations

import logging
import os
from typing import Hashable, Optional

logger = logging.getLogger("kymo")

_warned: set = set()


def warn_once(key: Hashable, msg: str, *args: object) -> None:
    """Log a warning the first time ``key`` is seen in this process."""
    if key in _warned:
        return
    _warned.add(key)  # benign race: worst case two identical warnings
    try:
        logger.warning("kymo: " + msg, *args)
    except Exception:
        pass


def env_str(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.environ.get(name)
    if v is None or not v.strip():
        return default
    return v.strip()


def env_bool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def env_float(name: str, default: float) -> float:
    v = env_str(name)
    if v is None:
        return default
    try:
        return float(v)
    except ValueError:
        warn_once(("env", name), "ignoring invalid %s=%r", name, v)
        return default


def default_spool_dir() -> str:
    d = env_str("KYMO_CACHE_DIR")
    if d:
        return os.path.expanduser(d)
    return os.path.join(os.path.expanduser("~"), ".cache", "kymo", "spool")
