import fractions
import json
import logging
import math
import threading

import kymo
from kymo._encode import flatten, key_is_valid, sanitize_json, to_number, _DROP


class LazyScalar:
    """A scalar that is only materialized when .item() is called."""

    def __init__(self, v):
        self.v = v
        self.item_threads = []

    def item(self):
        self.item_threads.append(threading.get_ident())
        return self.v


class MultiValue:
    def item(self):
        raise ValueError("more than one value")


class FloatLike:
    """Not a number subclass, no .item(): only __float__."""

    def __float__(self):
        return 0.75


def test_flatten_and_convert():
    out = {}
    dropped = []
    flatten(out, {"train": {"loss": 1.5, "acc": True}, "lr": 3e-4, "n": 7, "s": "x", "deep": {"a": {"b": 2}},
                  "t": LazyScalar(2.5), "fl": FloatLike(), "nan": float("nan"), "inf": math.inf, "ninf": -math.inf, "none": None,
                  "frac": fractions.Fraction(1, 4), "big": 2**70, "multi": MultiValue(), 3: 1.0},
            "", lambda k, v: dropped.append(k))
    assert out == {"train/loss": 1.5, "train/acc": 1, "lr": 3e-4, "n": 7, "deep/a/b": 2, "t": 2.5, "fl": 0.75, "nan": "NaN",
                   "inf": "Infinity", "ninf": "-Infinity", "frac": 0.25, "big": float(2**70), "3": 1.0}
    assert sorted(dropped) == ["multi", "none", "s"]


def test_to_number_item_and_float_variants():
    assert to_number(LazyScalar(True)) == 1
    assert to_number(LazyScalar(float("nan"))) == "NaN"
    assert to_number(LazyScalar(3)) == 3
    assert to_number(LazyScalar(1 + 2j)) is _DROP
    assert to_number(b"1") is _DROP
    assert to_number(FloatLike()) == 0.75
    assert to_number(object()) is _DROP


def test_keys_and_config():
    assert key_is_valid("train/loss")
    assert not key_is_valid("")
    assert not key_is_valid("a\nb")
    assert not key_is_valid("x" * 257)
    assert not key_is_valid("\ud800")
    cfg = sanitize_json({"lr": 1e-3, "model": {"d": 4096, "f": float("inf")}, "layers": (1, 2), "obj": object})
    assert cfg["model"] == {"d": 4096, "f": "Infinity"}
    assert cfg["layers"] == [1, 2]
    assert isinstance(cfg["obj"], str)
    json.dumps(cfg, allow_nan=False)


def test_item_called_on_background_thread_and_nan_on_wire(server):
    t = LazyScalar(0.5)
    run = kymo.init(project="p", experiment="e", host=server.url)
    run.log({"loss": t, "nan": float("nan"), "pinf": float("inf"), "ninf": float("-inf"), "flag": False})
    assert run.flush(5)
    assert t.item_threads and threading.get_ident() not in t.item_threads
    raw = [r["raw"] for r in server.requests if b'"points":[{' in r["raw"]][0].decode()
    assert '"nan":"NaN"' in raw and '"pinf":"Infinity"' in raw and '"ninf":"-Infinity"' in raw
    assert '"flag":0' in raw and '"loss":0.5' in raw
    json.loads(raw)  # strictly valid JSON (no bare NaN tokens)


def test_non_numeric_warns_once_per_key(server, caplog):
    run = kymo.init(project="p", experiment="e2", host=server.url)
    with caplog.at_level(logging.WARNING, logger="kymo"):
        for i in range(5):
            run.log({"loss": i, "note_once_key": "hello"})
        run.flush(5)
    msgs = [r.getMessage() for r in caplog.records if "note_once_key" in r.getMessage()]
    assert len(msgs) == 1
    pts = server.points("e2")
    assert [p["metrics"] for p in pts] == [{"loss": i} for i in range(5)]
