"""Kymo: a tiny, non-blocking metrics logger for ML training.

    import kymo
    run = kymo.init(project="llm-pretrain", experiment="7b-lr3e-4", config={"lr": 3e-4})
    for step in range(N):
        run.log({"train/loss": loss, "lr": lr}, step=step)
    run.finish()   # optional, also done at exit

``log()`` only shallow-copies the dict and appends it to a deque; everything
else (value conversion, flattening, JSON, gzip, HTTP, retries, disk spool)
happens on background daemon threads.  Nothing in this package raises into
the training loop.
"""

from __future__ import annotations

import atexit
import os
import re
import socket
import sys
import threading
import time
from typing import Any, List, Mapping, Optional, Union

from ._run import NoopRun, Run
from ._util import default_spool_dir, env_bool, env_float, env_str, warn_once
from ._version import __version__

__all__ = ["init", "log", "flush", "finish", "Run", "NoopRun", "__version__"]

DEFAULT_HOST = "http://localhost:8080"

_lock = threading.Lock()
_runs: List[Run] = []
_last: Union[Run, NoopRun, None] = None
_hooks_installed = False
_exc_seen = False
_prev_excepthook = None
_owner_pid = os.getpid()


_PROJECT_BAD = re.compile(r"[^A-Za-z0-9_.-]")


def _clean_project(name: Any) -> str:
    s = str(name or "").strip()
    clean = _PROJECT_BAD.sub("-", s)[:64] or "default"
    if clean != s:
        warn_once(("project-name", s), "project name %r is not [A-Za-z0-9_.-]{1,64}; using %r", s, clean)
    return clean


def _clean_experiment(name: Any) -> str:
    s = str(name).strip() if name is not None else ""
    if not s:
        try:
            hn = socket.gethostname().split(".")[0]
        except Exception:
            hn = "run"
        s = "%s-%s" % (hn, time.strftime("%Y%m%d-%H%M%S"))
    if len(s) > 128:
        warn_once(("exp-name", s), "experiment name longer than 128 chars; truncated")
        s = s[:128]
    return s


def _normalize_host(host: str) -> Optional[str]:
    h = host.strip().rstrip("/")
    if "://" not in h:
        h = "http://" + h
    scheme = h.split("://", 1)[0].lower()
    if scheme not in ("http", "https"):
        return None
    return h


def init(
    project: str,
    experiment: Optional[str] = None,
    *,
    config: Optional[Mapping[str, Any]] = None,
    api_key: Optional[str] = None,
    host: Optional[str] = None,
    enabled: bool = True,
    offline: Optional[bool] = None,
    flush_interval: float = 1.0,
    max_batch_points: int = 10_000,
    max_memory_bytes: int = 256 * 1024 * 1024,
) -> Union[Run, NoopRun]:
    """Start a run and return it (also becomes the target of ``kymo.log``).

    ``api_key`` defaults to ``$KYMO_API_KEY``, ``host`` to ``$KYMO_HOST`` or
    ``http://localhost:8080``.  Every process that calls ``init`` logs; pass
    ``enabled=False`` (e.g. ``enabled=(worker_id == 0)``) to get a no-op run.
    Never raises: on any internal problem a warning is logged and a no-op run
    returned.
    """
    global _last
    try:
        proj = _clean_project(project)
        exp = _clean_experiment(experiment)
        if env_bool("KYMO_DISABLED"):
            _last = NoopRun(proj, exp, "KYMO_DISABLED")
            return _last
        if not enabled:
            _last = NoopRun(proj, exp, "enabled=False")
            return _last

        key = api_key if api_key else env_str("KYMO_API_KEY")
        raw_host = host if host else env_str("KYMO_HOST", DEFAULT_HOST)
        base = _normalize_host(raw_host or DEFAULT_HOST)
        off = env_bool("KYMO_OFFLINE") if offline is None else bool(offline)
        if base is None:
            warn_once(("bad-host", raw_host), "KYMO_HOST %r is not an http(s) URL; running offline (spool only)", raw_host)
            base = DEFAULT_HOST
            off = True
        if not key and not off:
            warn_once("no-key", "no API key (set KYMO_API_KEY or pass api_key=); running offline, data is spooled "
                                "to disk for `python -m kymo sync`")
            off = True

        run = Run(
            proj,
            exp,
            config=config,
            api_key=key,
            host=base,
            spool_dir=default_spool_dir(),
            offline=off,
            flush_interval=flush_interval,
            max_batch_points=max_batch_points,
            max_memory_bytes=max_memory_bytes,
            exit_timeout=env_float("KYMO_EXIT_TIMEOUT", 30.0),
            http_timeout=env_float("KYMO_HTTP_TIMEOUT", 60.0),
        )
        with _lock:
            _runs.append(run)
            _install_hooks()
        _last = run
        return run
    except Exception as e:
        warn_once(("init-bug", type(e).__name__), "could not start run (%r); logging disabled", e)
        _last = NoopRun(str(project), str(experiment), "init failed")
        return _last


def log(data: Mapping[str, Any], step: Optional[int] = None) -> None:
    """``run.log`` on the most recent run (no-op if there is none)."""
    r = _last
    if r is not None:
        r.log(data, step)


def flush(timeout: Optional[float] = 30.0) -> bool:
    """Wait until the most recent run's data is acknowledged by the server."""
    r = _last
    return r.flush(timeout) if r is not None else True


def finish(status: Optional[str] = None, timeout: Optional[float] = None) -> None:
    """Finish the most recent run."""
    r = _last
    if r is not None:
        r.finish(status, timeout)


# --------------------------------------------------------------------- hooks
def _excepthook(tp: Any, value: Any, tb: Any) -> None:
    global _exc_seen
    _exc_seen = True
    prev = _prev_excepthook or sys.__excepthook__
    prev(tp, value, tb)


def _atexit() -> None:
    if os.getpid() != _owner_pid:
        return  # forked child that exits through sys.exit(): not our runs
    with _lock:
        runs = list(_runs)
        _runs.clear()
    if not runs:
        return
    status = "failed" if _exc_seen else "finished"
    timeout = env_float("KYMO_EXIT_TIMEOUT", 30.0)
    deadline = time.monotonic() + timeout
    for r in runs:
        try:
            r.finish(status, timeout=max(0.0, deadline - time.monotonic()))
        except Exception:
            pass


def _install_hooks() -> None:
    global _hooks_installed, _prev_excepthook
    if _hooks_installed:
        return
    _hooks_installed = True
    _prev_excepthook = sys.excepthook
    sys.excepthook = _excepthook
    atexit.register(_atexit)


def _after_fork_child() -> None:
    global _lock, _last, _owner_pid, _exc_seen
    _lock = threading.Lock()
    for r in _runs:
        try:
            r._after_fork_child()
        except Exception:
            pass
    _runs.clear()
    _last = None
    _owner_pid = os.getpid()
    _exc_seen = False


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork_child)


def _finish_all(timeout: float = 5.0) -> None:
    """Finish every live run (used by tests)."""
    with _lock:
        runs = list(_runs)
        _runs.clear()
    for r in runs:
        r.finish(timeout=timeout)


