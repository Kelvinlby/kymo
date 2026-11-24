"""Value conversion, flattening and JSON/gzip encoding (background thread only)."""

from __future__ import annotations

import json
import re
import zlib
from collections.abc import Mapping
from typing import Any, Callable, Dict, Tuple

_INF = float("inf")
_I64_MIN = -(2**63)
_I64_MAX = 2**63 - 1
GZIP_MIN_BYTES = 4096
MAX_KEY_BYTES = 256
_MAX_DEPTH = 32

_DROP = object()
_BAD_KEY_CHARS = re.compile("[\x00-\x1f\x7f-\x9f]")


def _float(v: float) -> Any:
    if v - v == 0.0:  # finite (inf - inf and nan - nan are nan)
        return v
    if v != v:
        return "NaN"
    return "Infinity" if v > 0 else "-Infinity"


def _int(v: int) -> Any:
    if _I64_MIN <= v <= _I64_MAX:
        return v
    try:
        return _float(float(v))
    except OverflowError:
        return _float(_INF if v > 0 else -_INF)


def to_number(v: Any) -> Any:
    """Convert one metric value to its wire form, or return ``_DROP``.

    Generic rules, no knowledge of any library: plain numbers and bools, then
    any object whose ``.item()`` returns a number, then anything with
    ``__float__``.  Calling ``.item()``/``__float__`` may be slow for lazily
    evaluated scalars, so this only ever runs on the background thread.
    """
    t = type(v)
    if t is float:
        return _float(v)
    if t is bool:
        return 1 if v else 0
    if t is int:
        return _int(v)
    if isinstance(v, (str, bytes, bytearray)) or v is None:
        return _DROP
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, int):
        return _int(int(v))
    if isinstance(v, float):
        return _float(float(v))
    item = getattr(v, "item", None)
    if item is not None and callable(item):
        try:
            x = item()
        except Exception:
            return _DROP  # e.g. a multi-element container
        tx = type(x)
        if tx is bool or isinstance(x, bool):
            return 1 if x else 0
        if tx is int or isinstance(x, int):
            return _int(int(x))
        if tx is float or isinstance(x, float):
            return _float(float(x))
        return _DROP  # complex, str, ...
    # Fraction, Decimal and any other object implementing __float__.
    if hasattr(type(v), "__float__"):
        try:
            return _float(float(v))
        except Exception:
            return _DROP
    return _DROP


def flatten(
    out: Dict[str, Any],
    data: Mapping,
    prefix: str,
    on_drop: Callable[[str, Any], None],
    depth: int = 0,
) -> None:
    """Flatten nested mappings into ``out`` with "/" separators, converting values."""
    for k, v in data.items():
        key = prefix + (k if type(k) is str else str(k))
        t = type(v)
        if t is float:
            out[key] = v if v - v == 0.0 else _float(v)
        elif t is int:
            out[key] = _int(v)
        elif t is dict or isinstance(v, Mapping):
            if depth < _MAX_DEPTH:
                flatten(out, v, key + "/", on_drop, depth + 1)
        else:
            r = to_number(v)
            if r is _DROP:
                on_drop(key, v)
            else:
                out[key] = r


def key_is_valid(key: str) -> bool:
    try:
        n = len(key.encode("utf-8"))
    except UnicodeEncodeError:
        return False
    return 1 <= n <= MAX_KEY_BYTES and _BAD_KEY_CHARS.search(key) is None


def sanitize_json(v: Any, depth: int = 0) -> Any:
    """Make an arbitrary config value JSON-safe (used for ``config`` only)."""
    if depth > _MAX_DEPTH:
        return str(v)
    t = type(v)
    if v is None or t is str or t is bool:
        return v
    if t is int:
        return v
    if t is float:
        return _float(v)
    if isinstance(v, Mapping):
        return {str(k): sanitize_json(x, depth + 1) for k, x in v.items()}
    if isinstance(v, (list, tuple, set, frozenset)):
        return [sanitize_json(x, depth + 1) for x in v]
    if isinstance(v, bool):
        return bool(v)
    if isinstance(v, int):
        return int(v)
    if isinstance(v, str):
        return str(v)
    r = to_number(v)
    if r is not _DROP:
        return r
    return str(v)


def dumps(obj: Any) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


_point_encoder = json.JSONEncoder(separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode

# Bytes fed to zlib per call. Small enough that no single C call holds the GIL for long.
_GZIP_CHUNK = 64 * 1024
# Points JSON-encoded per C call.
_POINT_CHUNK = 64


def _dumps_incremental(obj: Any) -> bytes:
    """Same bytes as dumps(obj), but built in chunks of points.

    json.dumps of a whole 250k-value batch is one C call that holds the GIL for tens of
    milliseconds, stalling a pure-Python training thread. Encoding _POINT_CHUNK points per
    call (~0.2 ms each, same total CPU) lets the interpreter switch back to it in between.
    """
    pts = obj.get("points") if isinstance(obj, dict) else None
    if not pts or len(pts) <= _POINT_CHUNK:
        return dumps(obj)
    head = {k: v for k, v in obj.items() if k != "points"}
    hb = dumps(head)  # b"{...}"
    parts = [hb[:-1] + (b',"points":[' if head else b'"points":[')]
    enc = _point_encoder
    for i in range(0, len(pts), _POINT_CHUNK):
        s = enc(pts[i : i + _POINT_CHUNK])[1:-1].encode("utf-8")  # strip [ ]
        parts.append(s if i == 0 else b"," + s)
    parts.append(b"]}")
    return b"".join(parts)


def encode_body(obj: Any) -> Tuple[bytes, bool]:
    """Return (wire bytes, gzipped?)."""
    raw = _dumps_incremental(obj)
    if len(raw) <= GZIP_MIN_BYTES:
        return raw, False
    co = zlib.compressobj(3, zlib.DEFLATED, 31)  # wbits=31 -> gzip container, mtime 0
    mv = memoryview(raw)
    out = [co.compress(mv[i : i + _GZIP_CHUNK]) for i in range(0, len(raw), _GZIP_CHUNK)]
    out.append(co.flush())
    return b"".join(out), True
