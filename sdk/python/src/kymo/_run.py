"""Run objects: the hot-path ``log()`` plus the background collector."""

from __future__ import annotations

import os
import socket
import threading
import time
import uuid
from collections import deque
from time import time as _now
from typing import Any, Dict, List, Mapping, Optional

from ._encode import flatten, key_is_valid, sanitize_json
from ._sender import Batch, Outbox, Sender, spool_batch
from ._spool import Spool
from ._transport import Transport
from ._util import logger, warn_once

MAX_BATCH_VALUES = 250_000  # well below the server's 1M values / 64 MiB per request
_YIELD_EVERY = 512  # collector releases the GIL this often while draining


def _noop(_item: Any) -> None:
    return None


class NoopRun:
    """Returned when logging is disabled (``enabled=False``, KYMO_DISABLED, init failure)."""

    disabled = True

    def __init__(self, project: str = "", experiment: str = "", reason: str = "disabled"):
        self.project = project
        self.experiment = experiment
        self.reason = reason
        self.client_id = ""

    def log(self, data: Mapping[str, Any], step: Optional[int] = None) -> None:
        return None

    def flush(self, timeout: Optional[float] = None) -> bool:
        return True

    def finish(self, status: Optional[str] = None, timeout: Optional[float] = None) -> None:
        return None

    def __enter__(self) -> "NoopRun":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def __repr__(self) -> str:
        return "<kymo.NoopRun %s/%s (%s)>" % (self.project, self.experiment, self.reason)


class Run:
    """A live experiment run.  Create it with :func:`kymo.init`."""

    disabled = False

    def __init__(
        self,
        project: str,
        experiment: str,
        *,
        config: Optional[Mapping[str, Any]],
        api_key: Optional[str],
        host: str,
        spool_dir: str,
        offline: bool,
        flush_interval: float,
        max_batch_points: int,
        max_memory_bytes: int,
        metric_prefix: str = "",
        exit_timeout: float,
        http_timeout: float,
    ):
        self.project = project
        self.experiment = experiment
        self.host = host
        self.offline = offline
        self.client_id = uuid.uuid4().hex
        self.exit_timeout = exit_timeout
        self._pid = os.getpid()
        self._flush_interval = max(0.01, float(flush_interval))
        self._max_points = max(1, int(max_batch_points))
        self._prefix = metric_prefix

        # Hot path state: log() touches only these two.
        self._q: deque = deque()
        self._push = self._q.append

        # Collector state: only touched by the kymo-collector thread.
        self._points: List[dict] = []
        self._values = 0
        self._started = 0.0
        self._next_step = 0
        self._seq = 0
        self._good_keys: set = set()
        self._bad_keys: set = set()

        self._finish_lock = threading.Lock()
        self._finished = False
        # flush()/finish() ask the collector to drain via a request counter.
        self._wake = threading.Event()
        self._ccond = threading.Condition(threading.Lock())
        self._req = 0
        self._done = 0
        self._stopping = False

        self._spool = Spool(spool_dir, host, api_key)
        self._outbox = Outbox(int(max_memory_bytes), self._spool, offline)
        self._sender: Optional[Sender] = None

        hello: Dict[str, Any] = self._header()
        hello["status"] = "running"
        try:
            hello["host"] = socket.gethostname()
        except Exception:
            pass
        if config:
            try:
                hello["config"] = sanitize_json(dict(config))
            except Exception as e:
                warn_once("config", "could not serialize config (%s); not sent", e)
        hello["points"] = []
        self._outbox.put(Batch(hello, hello["seq"], "hello"))

        if not offline:
            self._sender = Sender(Transport(host, api_key, timeout=http_timeout), self._outbox, self._spool)
            self._sender.start()
        self._collector = threading.Thread(target=self._collect_loop, name="kymo-collector", daemon=True)
        self._collector.start()

    # ------------------------------------------------------------- hot path
    def log(self, data: Mapping[str, Any], step: Optional[int] = None) -> None:
        """Record metrics.  Only a shallow copy + deque append happen here; never raises."""
        try:
            self._push((step, _now(), data.copy()))  # type: ignore[attr-defined]
        except Exception:
            try:
                self._push((step, _now(), dict(data)))
            except Exception:
                pass

    # ------------------------------------------------------------ collector
    def _header(self) -> Dict[str, Any]:
        seq = self._seq
        self._seq += 1
        return {"project": self.project, "experiment": self.experiment, "client_id": self.client_id, "seq": seq}

    def _collect_loop(self) -> None:
        tick = min(0.05, self._flush_interval)
        while True:
            self._wake.wait(tick)
            self._wake.clear()
            with self._ccond:
                req, stopping = self._req, self._stopping
            force = stopping or req > self._done
            if force or self._q or self._points:
                try:
                    self._drain(force=force)
                except Exception as e:
                    warn_once(("collector-bug", type(e).__name__), "internal collector error: %r", e)
            if force:
                with self._ccond:
                    self._done = req
                    self._ccond.notify_all()
            if stopping:
                return

    def _request_drain(self, deadline: float, stop: bool = False) -> bool:
        """Ask the collector thread to convert everything queued so far and
        finalize the batch (value conversion, incl. ``.item()``, never runs on the
        caller's thread).  Returns False if it did not happen before ``deadline``."""
        with self._ccond:
            self._req += 1
            target = self._req
            if stop:
                self._stopping = True
        self._wake.set()
        with self._ccond:
            while self._done < target:
                left = deadline - time.monotonic()
                if left <= 0 or not self._collector.is_alive():
                    return False
                self._ccond.wait(min(left, 0.1))
        return True

    def _drain(self, force: bool) -> None:
        pop = self._q.popleft
        n = 0
        while True:
            try:
                step, ts, data = pop()
            except IndexError:
                break
            try:
                self._add(step, ts, data)
            except Exception as e:
                warn_once(("log-bad", type(e).__name__), "could not process a log() call (%r); skipped", e)
            n += 1
            if n % _YIELD_EVERY == 0:
                time.sleep(0)  # let the training thread have the GIL
        if self._points and (force or time.monotonic() - self._started >= self._flush_interval):
            self._finalize()

    def _on_drop(self, key: str, value: Any) -> None:
        warn_once(("drop", key), "dropping non-numeric value for metric %r (%s); only numbers, bools and objects with .item()/__float__ are logged",
                  key, type(value).__name__)

    def _add(self, step: Any, ts: float, data: Mapping) -> None:
        metrics: Dict[str, Any] = {}
        flatten(metrics, data, self._prefix, self._on_drop)
        if step is None:
            step = self._next_step
        else:
            try:
                step = int(step.item() if hasattr(step, "item") else step)
            except Exception:
                warn_once("bad-step", "step must be an integer, got %r; point dropped", step)
                return
        self._next_step = step + 1
        good = self._good_keys
        for k in list(metrics):
            if k in good:
                continue
            if k not in self._bad_keys and key_is_valid(k):
                good.add(k)
            else:
                if k not in self._bad_keys:
                    self._bad_keys.add(k)
                    warn_once(("bad-key", k), "invalid metric key %r (1-256 bytes UTF-8, no control chars); dropped", k)
                del metrics[k]
        if not metrics:
            return
        if not self._points:
            self._started = time.monotonic()
        self._points.append({"step": step, "ts": ts, "metrics": metrics})
        self._values += len(metrics)
        if len(self._points) >= self._max_points or self._values >= MAX_BATCH_VALUES:
            self._finalize()

    def _finalize(self) -> None:
        body = self._header()
        body["points"] = self._points
        self._points = []
        self._values = 0
        self._outbox.put(Batch(body, body["seq"]))  # notifies the sender

    # -------------------------------------------------------------- control
    def flush(self, timeout: Optional[float] = 30.0) -> bool:
        """Block until everything logged so far is acknowledged by the server
        (or spooled when offline).  Returns False on timeout.  Never raises."""
        try:
            if self._finished:
                return self._outbox.idle()
            deadline = time.monotonic() + (30.0 if timeout is None else timeout)
            if not self._request_drain(deadline):
                return False
            if self._sender is None:
                return True
            self._sender.kick.set()
            return self._outbox.wait_idle(deadline, self._sender.gave_up)
        except Exception:
            return False

    def finish(self, status: Optional[str] = None, timeout: Optional[float] = None) -> None:
        """Flush, mark the experiment ``finished`` (or ``status``) and stop the
        background threads.  Waits at most ``timeout`` (default KYMO_EXIT_TIMEOUT,
        30 s); whatever is unsent by then is spooled to disk.  Never raises."""
        with self._finish_lock:
            if self._finished:
                return
            self._finished = True
        try:
            self._shutdown(status or "finished", self.exit_timeout if timeout is None else timeout)
        except Exception as e:
            warn_once(("finish-bug", type(e).__name__), "error while finishing run: %r", e)

    def _shutdown(self, status: str, timeout: float) -> None:
        if os.getpid() != self._pid:
            return
        deadline = time.monotonic() + max(0.0, timeout)
        self._push = _noop
        if not self._request_drain(deadline, stop=True):
            warn_once("collector-stuck", "background conversion did not finish in time; recent points may be lost")
        final = self._header()
        final["status"] = status
        final["points"] = []
        self._outbox.put(Batch(final, final["seq"], "final"))
        sender = self._sender
        if sender is None:
            return  # offline: everything already went to the spool
        sender.finishing(deadline)
        self._outbox.wait_idle(deadline, sender.gave_up)
        sender.stop()
        left = self._outbox.close()
        for b in left:
            spool_batch(self._spool, b)
        n = sum(1 for b in left if b.spool_path is None)
        if n:
            logger.warning("kymo: %s; %d unsent batch(es) spooled to %s (replayed by the next run or "
                           "`python -m kymo sync`)", "server unreachable" if sender.gave_up.is_set() else "timed out flushing",
                           n, self._spool.dir)

    def _after_fork_child(self) -> None:
        """In a forked child this run becomes inert (the threads don't exist there)."""
        self._push = _noop
        self._finished = True
        self._finish_lock = threading.Lock()
        self._ccond = threading.Condition(threading.Lock())
        self._q = deque()

    def __enter__(self) -> "Run":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.finish("failed" if exc_type is not None else "finished")

    def __repr__(self) -> str:
        return "<kymo.Run %s/%s %s>" % (self.project, self.experiment, "finished" if self._finished else "running")
