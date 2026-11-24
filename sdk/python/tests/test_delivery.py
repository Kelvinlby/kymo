import logging
import time

import kymo
from fakes import FakeIngest, free_port


def test_batching_steps_and_header(server):
    run = kymo.init(project="proj", experiment="exp", config={"lr": 0.1}, host=server.url, max_batch_points=10,
                    flush_interval=0.2)
    for i in range(25):
        run.log({"loss": float(i), "eval": {"acc": i / 100}})
    run.log({"loss": 99.0}, step=1000)
    run.log({"loss": 100.0})
    assert run.flush(10)
    bodies = server.ok_bodies()
    hello = bodies[0]
    assert hello["config"] == {"lr": 0.1} and hello["status"] == "running" and hello["points"] == []
    assert "host" in hello
    for b in bodies:
        assert b["project"] == "proj" and b["experiment"] == "exp" and b["client_id"] == run.client_id
    seqs = [b["seq"] for b in bodies]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    pts = server.points()
    assert [p["step"] for p in pts] == list(range(25)) + [1000, 1001]
    assert pts[3]["metrics"] == {"loss": 3.0, "eval/acc": 0.03}
    assert all(isinstance(p["ts"], float) for p in pts)
    assert max(len(b["points"]) for b in bodies) <= 10
    assert len([b for b in bodies if b["points"]]) >= 3
    run.finish()
    assert server.statuses()[-1] == "finished"
    # keep-alive: everything went over one connection
    assert server.connections == 1
    auth = {r["headers"].get("Authorization") for r in server.requests}
    assert auth == {"Bearer kymo_testtoken"}


def test_gzip_only_for_large_bodies(server):
    run = kymo.init(project="p", experiment="gz", host=server.url)
    run.log({"x": 1})
    assert run.flush(5)
    small = [r for r in server.requests if r["body"]["points"]]
    assert small and not small[0]["gz"]
    run.log({"k%d" % i: float(i) for i in range(1000)})
    assert run.flush(5)
    big = [r for r in server.requests if r["body"]["points"] and len(r["body"]["points"][0]["metrics"]) == 1000]
    assert big and big[0]["gz"] and big[0]["headers"]["Content-Encoding"] == "gzip"
    assert len(big[0]["raw"]) > 4096


def test_retry_on_503_and_429_with_retry_after(server):
    server.script.extend([503, (429, {"Retry-After": "0.3"}), 502])
    run = kymo.init(project="p", experiment="r", host=server.url)
    t0 = time.monotonic()
    run.log({"x": 1})
    assert run.flush(10)
    assert time.monotonic() - t0 >= 0.3  # Retry-After honored
    assert [r["status"] for r in server.requests][:4] == [503, 429, 502, 200]
    assert len(server.points("r")) == 1


def test_retry_on_connection_refused():
    port = free_port()
    run = kymo.init(project="p", experiment="refused", host="http://127.0.0.1:%d" % port)
    run.log({"x": 1})
    time.sleep(0.5)  # several refused attempts
    srv = FakeIngest(port)
    try:
        assert run.flush(10)
        assert [p["metrics"] for p in srv.points("refused")] == [{"x": 1}]
    finally:
        run.finish(timeout=2)
        srv.close()


def test_no_retry_on_401(server, caplog):
    server.script.extend([401] * 50)
    with caplog.at_level(logging.WARNING, logger="kymo"):
        run = kymo.init(project="p", experiment="auth", host=server.url, flush_interval=0.05)
        run.log({"x": 1})
        run.flush(5)
        time.sleep(0.2)
        run.log({"x": 2})
        run.flush(5)
    # hello + 2 point batches, each tried exactly once
    assert [r["status"] for r in server.requests] == [401, 401, 401]
    assert len([r for r in caplog.records if "401" in r.getMessage()]) == 1


def test_no_retry_on_400(server):
    server.script.append(400)
    run = kymo.init(project="p", experiment="bad", host=server.url)
    run.log({"x": 1})
    assert run.flush(5)
    assert [r["status"] for r in server.requests][0] == 400
    assert len(server.requests) == 2  # hello dropped, point batch sent once


def test_413_split(server):
    server.max_values = 3
    run = kymo.init(project="p", experiment="split", host=server.url, flush_interval=10, max_batch_points=100)
    for i in range(10):
        run.log({"x": i})
    run.log({"a": 1, "b": 2, "c": 3, "d": 4, "e": 5}, step=50)  # single point, split by metrics
    assert run.flush(10)
    pts = server.points("split")
    xs = sorted(p["metrics"]["x"] for p in pts if "x" in p["metrics"])
    assert xs == list(range(10))
    merged = {}
    for p in pts:
        if p["step"] == 50:
            merged.update(p["metrics"])
    assert merged == {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5}
    assert 413 in [r["status"] for r in server.requests]


def test_memory_cap_spills_to_disk_then_replays(spool_dir):
    port = free_port()
    run = kymo.init(project="p", experiment="cap", host="http://127.0.0.1:%d" % port, max_batch_points=1,
                    max_memory_bytes=1)
    for i in range(20):
        run.log({"x": i})
    deadline = time.monotonic() + 5
    while len(list(spool_dir.glob("*.json"))) < 10 and time.monotonic() < deadline:
        time.sleep(0.05)
    assert len(list(spool_dir.glob("*.json"))) >= 10  # spilled during the run, not only at exit
    srv = FakeIngest(port)
    try:
        assert srv.wait_for(lambda: len(srv.points("cap")) == 20, 15)
        assert sorted(p["metrics"]["x"] for p in srv.points("cap")) == list(range(20))
        run.finish(timeout=5)
        assert srv.wait_for(lambda: not list(spool_dir.glob("*.json")), 5)
    finally:
        srv.close()
