"""Outbox (memory-capped batch queue) and the HTTP sender thread."""

from __future__ import annotations

import email.utils
import gzip
import json
import random
import threading
import time
from collections import deque
from typing import Deque, List, Optional

from ._encode import dumps, encode_body
from ._spool import Spool
from ._transport import Transport
from ._util import logger, warn_once

INGEST_PATH = "/api/v1/ingest"

# Tunables (module-level so tests can shrink them).
BACKOFF_BASE = 0.5
BACKOFF_CAP = 60.0
RETRY_AFTER_MAX = 300.0
FINISH_MAX_FAILURES = 3  # consecutive failures while finishing before we spool the rest
RESCAN_INTERVAL = 30.0  # seconds between spool directory scans when idle

OK, DROP, SPLIT, AUTH, GIVEUP = "ok", "drop", "split", "auth", "giveup"


class Batch:
    __slots__ = ("seq", "data", "gz", "kind", "counted", "spool_path")

    def __init__(self, body: dict, seq: int, kind: str = "points", spool_path: Optional[str] = None):
        self.seq = seq
        self.data, self.gz = encode_body(body)
        self.kind = kind  # "hello" | "points" | "final" | "replay"
        self.counted = False
        self.spool_path = spool_path

    @property
    def size(self) -> int:
        return len(self.data)

    def raw(self) -> bytes:
        return gzip.decompress(self.data) if self.gz else self.data

    def body(self) -> dict:
        return json.loads(self.raw())


def spool_batch(spool: Spool, batch: Batch) -> None:
    """Write a batch to disk.  A spooled "running" status is stripped so a late
    replay can never flip a finished experiment back to running."""
    if batch.spool_path is not None:
        Spool.release(batch.spool_path)
        return
    try:
        raw = batch.raw()
        if batch.kind == "hello":
            body = json.loads(raw)
            if body.get("status") == "running":
                del body["status"]
            raw = dumps(body)
        spool.write(raw, batch.seq)
    except Exception as e:  # pragma: no cover - defensive
        warn_once(("spool-batch", type(e).__name__), "failed to spool batch: %s", e)


def split_batch(batch: Batch) -> List[Batch]:
    """Split a batch the server rejected with 413 into two halves (or [] if impossible)."""
    body = batch.body()
    pts = body.get("points") or []
    head = {k: v for k, v in body.items() if k not in ("points", "config", "status")}
    a, b = dict(head), dict(head)
    if "config" in body:
        a["config"] = body["config"]
    if "status" in body:
        b["status"] = body["status"]
    if len(pts) >= 2:
        mid = len(pts) // 2
        a["points"], b["points"] = pts[:mid], pts[mid:]
    elif len(pts) == 1 and len(pts[0].get("metrics") or {}) >= 2:
        p = pts[0]
        items = list(p["metrics"].items())
        mid = len(items) // 2
        a["points"] = [{"step": p.get("step"), "ts": p.get("ts"), "metrics": dict(items[:mid])}]
        b["points"] = [{"step": p.get("step"), "ts": p.get("ts"), "metrics": dict(items[mid:])}]
    else:
        return []
    kind = "points" if batch.kind == "replay" else batch.kind
    return [Batch(a, batch.seq, kind), Batch(b, batch.seq, kind)]


def parse_retry_after(v: Optional[str]) -> Optional[float]:
    if not v:
        return None
    v = v.strip()
    try:
        return max(0.0, float(v))
    except ValueError:
        pass
    try:
        dt = email.utils.parsedate_to_datetime(v)
        return max(0.0, dt.timestamp() - time.time())
    except Exception:
        return None


class Outbox:
    """FIFO of encoded batches bounded by ``cap`` bytes; overflow goes to the spool."""

    def __init__(self, cap: int, spool: Spool, offline: bool):
        self.cap = cap
        self.spool = spool
        self.offline = offline
        self.cond = threading.Condition(threading.Lock())
        self.items: Deque[Batch] = deque()
        self.bytes = 0
        self.inflight: Optional[Batch] = None
        self.closed = False
        self.spooled = 0  # number of batches spilled to disk during the run

    def put(self, batch: Batch, front: bool = False) -> None:
        spill = False
        with self.cond:
            if self.closed or self.offline:
                spill = True
            elif not front and self.items and self.bytes + batch.size > self.cap:
                spill = True
            else:
                batch.counted = True
                self.bytes += batch.size
                if front:
                    self.items.appendleft(batch)
                else:
                    self.items.append(batch)
                self.cond.notify_all()
        if spill:
            if not self.offline and not self.closed:
                warn_once("mem-cap", "unsent data exceeds max_memory_bytes; spilling to %s", self.spool.dir)
            self.spooled += 1
            spool_batch(self.spool, batch)

    def get(self, timeout: float) -> Optional[Batch]:
        with self.cond:
            if not self.items and not self.closed:
                self.cond.wait(timeout)
            if self.closed or not self.items:
                return None
            b = self.items.popleft()
            self.inflight = b
            return b

    def set_inflight(self, batch: Batch) -> bool:
        with self.cond:
            if self.closed or self.items:
                return False
            self.inflight = batch
            return True

    def done(self, batch: Batch) -> None:
        with self.cond:
            if self.inflight is batch:
                self.inflight = None
            if batch.counted:
                batch.counted = False
                self.bytes -= batch.size
            self.cond.notify_all()

    def idle(self) -> bool:
        return not self.items and self.inflight is None

    def wait_idle(self, deadline: float, abort: Optional[threading.Event] = None) -> bool:
        with self.cond:
            while not (not self.items and self.inflight is None):
                if abort is not None and abort.is_set():
                    return False
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                self.cond.wait(min(left, 0.1))
            return True

    def close(self) -> List[Batch]:
        """Stop accepting work and return everything not yet acknowledged."""
        with self.cond:
            self.closed = True
            out = list(self.items)
            if self.inflight is not None:
                out.insert(0, self.inflight)
            self.items.clear()
            self.inflight = None
            self.bytes = 0
            self.cond.notify_all()
            return out


class Sender:
    """Delivers batches with retries.  Runs as the ``kymo-sender`` daemon thread
    (``start()``) or synchronously (``deliver()``, used by ``python -m kymo sync``)."""

    def __init__(self, transport: Transport, outbox: Optional[Outbox], spool: Spool, replay: bool = True):
        self.transport = transport
        self.outbox = outbox
        self.spool = spool
        self.replay = replay
        self.halt = threading.Event()  # stop for good
        self.kick = threading.Event()  # interrupt a backoff sleep
        self.gave_up = threading.Event()
        self.deadline: Optional[float] = None  # set while finishing
        self.max_failures: Optional[int] = None
        self.fail_streak = 0
        self._replay_queue: List[str] = []
        self._last_scan = -1e18
        self.thread: Optional[threading.Thread] = None
        self.sent_points = 0

    # ---------------------------------------------------------------- control
    def start(self) -> None:
        self.thread = threading.Thread(target=self._loop, name="kymo-sender", daemon=True)
        self.thread.start()

    def finishing(self, deadline: float) -> None:
        self.deadline = deadline
        self.max_failures = FINISH_MAX_FAILURES
        self.fail_streak = 0
        self.kick.set()

    def stop(self) -> None:
        self.halt.set()
        self.kick.set()
        self.transport.abort()

    # ------------------------------------------------------------------- loop
    def _loop(self) -> None:
        ob = self.outbox
        assert ob is not None
        while not self.halt.is_set():
            try:
                batch = ob.get(0.25)
                if batch is None:
                    if ob.closed:
                        return
                    batch = self._next_replay()
                    if batch is None:
                        continue
                res = self.deliver(batch)
                if res == GIVEUP:
                    self.gave_up.set()
                    with ob.cond:
                        ob.cond.notify_all()
                    return
                self._after(batch, res)
            except Exception as e:  # never die silently on a bug
                warn_once(("sender-bug", type(e).__name__), "internal sender error: %r", e)
                logger.debug("kymo sender error", exc_info=True)
                time.sleep(0.5)
        self.transport.close()

    def _after(self, batch: Batch, res: str) -> None:
        ob = self.outbox
        if res == SPLIT:
            halves = split_batch(batch)
            if not halves:
                warn_once("413-unsplittable", "server rejected a single metric value as too large (413); dropped")
            elif ob is not None:
                for h in reversed(halves):
                    ob.put(h, front=True)
        if batch.spool_path is not None:
            if res == AUTH:
                Spool.release(batch.spool_path)
                self.replay = False
            else:
                Spool.remove(batch.spool_path)
        if ob is not None:
            ob.done(batch)

    def _next_replay(self) -> Optional[Batch]:
        ob = self.outbox
        if not self.replay or ob is None:
            return None
        if not self._replay_queue:
            now = time.monotonic()
            if ob.spooled == 0 and now - self._last_scan < RESCAN_INTERVAL:
                return None
            ob.spooled = 0
            self._last_scan = now
            self._replay_queue = self.spool.pending()
            self._replay_queue.reverse()  # pop() from the end = oldest first
        while self._replay_queue:
            got = self.spool.claim(self._replay_queue.pop())
            if got is None:
                continue
            claimed, body = got
            try:
                batch = Batch(body, int(body.get("seq") or 0), "replay", spool_path=claimed)
            except Exception:
                Spool.release(claimed)
                continue
            if not ob.set_inflight(batch):
                Spool.release(claimed)  # live data arrived first; replay later
                self._replay_queue.clear()
                self._last_scan = -1e18
                return None
            return batch
        return None

    # ---------------------------------------------------------------- deliver
    def deliver(self, batch: Batch) -> str:
        headers = {"Content-Encoding": "gzip"} if batch.gz else None
        attempt = 0
        while True:
            if self.halt.is_set():
                return GIVEUP
            status: Optional[int] = None
            retry_after: Optional[float] = None
            try:
                status, ra, data = self.transport.post(INGEST_PATH, batch.data, headers)
                retry_after = parse_retry_after(ra)
            except Exception as e:
                if self.halt.is_set():
                    return GIVEUP
                warn_once(("net", type(e).__name__), "cannot reach %s (%s: %s); retrying in the background",
                          self.transport.netloc, type(e).__name__, e)
            if status is not None:
                if 200 <= status < 300:
                    self.fail_streak = 0
                    self._check_response(data)
                    return OK
                if status == 413:
                    self.fail_streak = 0
                    return SPLIT
                if status in (401, 403):
                    warn_once(("http", status), "server rejected the API key (HTTP %d); dropping data. Check KYMO_API_KEY.", status)
                    return AUTH
                if status == 407:
                    warn_once(("http", 407), "proxy %s requires authentication (HTTP 407); check the credentials in "
                              "HTTP(S)_PROXY. Retrying with backoff", getattr(self.transport.proxy, "url", "?"))
                elif status not in (408, 425, 429) and status < 500:
                    warn_once(("http", status), "server rejected a batch (HTTP %d: %s); dropped", status, _snippet(data))
                    return DROP
                else:
                    warn_once(("http-retry", status), "server returned HTTP %d; retrying with backoff", status)
            attempt += 1
            self.fail_streak += 1
            delay = random.uniform(0.0, min(BACKOFF_CAP, BACKOFF_BASE * (2 ** min(attempt - 1, 30))))
            if retry_after is not None:
                delay = max(delay, min(retry_after, RETRY_AFTER_MAX))
            if self.max_failures is not None and self.fail_streak >= self.max_failures:
                return GIVEUP
            if self.deadline is not None and time.monotonic() + delay > self.deadline:
                return GIVEUP
            if self.kick.wait(delay):
                self.kick.clear()

    def _check_response(self, data: bytes) -> None:
        try:
            r = json.loads(data) if data else {}
            dropped = int(r.get("dropped") or 0)
            accepted = int(r.get("accepted") or 0)
        except Exception:
            return
        self.sent_points += accepted
        if dropped:
            warn_once("server-dropped", "server dropped %d invalid values (see SPEC §3)", dropped)


def _snippet(data: bytes) -> str:
    try:
        return data[:200].decode("utf-8", "replace")
    except Exception:
        return ""
