import gzip
import json
import threading
import time

from kymo._encode import dumps, encode_body


def _body(n):
    pts = [{"step": i, "ts": 1.5e9 + i, "metrics": {f"layers/layer{k}/x": k * 1.1 + i for k in range(25)}} for i in range(n)]
    return {"project": "p", "experiment": "e", "config": {"lr": 1e-3}, "points": pts}


def test_chunked_encoding_is_byte_identical():
    for n in (0, 1, 63, 64, 65, 1000):
        body = _body(n)
        raw, gz = encode_body(body)
        data = gzip.decompress(raw) if gz else raw
        assert data == dumps(body)
        assert json.loads(data) == body
    raw, gz = encode_body({"points": _body(200)["points"]})
    assert json.loads(gzip.decompress(raw)) == {"points": _body(200)["points"]}


def test_encoding_does_not_hold_gil_for_long():
    body = _body(10000)
    stop = False
    worst = 0.0

    def spin():
        nonlocal worst
        last = time.perf_counter()
        while not stop:
            now = time.perf_counter()
            worst = max(worst, now - last)
            last = now

    t = threading.Thread(target=spin)
    t.start()
    time.sleep(0.02)
    worst = 0.0
    encode_body(body)
    stop = True
    t.join()
    # Python's default switch interval is 5 ms; a single 10k-point json.dumps holds it ~35 ms.
    assert worst < 0.015, f"training thread stalled {worst * 1e3:.1f} ms"
