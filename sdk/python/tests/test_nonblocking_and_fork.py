import os
import time

import pytest

import kymo
from conftest import spool_files


def test_training_thread_never_waits_on_hanging_server(hanging, spool_dir, monkeypatch):
    """The server accepts TCP connections but never answers: log() must stay fast."""
    monkeypatch.setenv("KYMO_HTTP_TIMEOUT", "30")
    run = kymo.init(project="p", experiment="hang", host=hanging.url, flush_interval=0.05)
    d = {"loss": 1.0, "lr": 3e-4, "a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 6, "g": 7, "h": 8}
    t0 = time.perf_counter()
    for i in range(100_000):
        run.log(d, step=i)
    dt = time.perf_counter() - t0
    print("100k log() calls against a hanging server: %.3f s (%.2f us/call)" % (dt, dt * 10))
    assert dt < 2.0
    assert hanging.conns  # the sender really is stuck on the hanging connection
    t0 = time.perf_counter()
    run.finish(timeout=1.0)
    took = time.perf_counter() - t0
    assert took < 3.0, took  # exit timeout honored even though a request is stuck
    files = spool_files(spool_dir)
    import json

    steps = set()
    for f in files:
        for p in json.loads(f.read_text())["body"]["points"]:
            steps.add(p["step"])
    assert steps == set(range(100_000))  # nothing lost: all spooled


def test_log_never_raises():
    run = kymo.init(project="p", experiment="weird", host="http://127.0.0.1:1")

    class Evil(dict):
        def copy(self):
            raise RuntimeError("nope")

        def items(self):
            raise RuntimeError("nope")

    run.log(None)  # type: ignore[arg-type]
    run.log(Evil(a=1))
    run.log([("a", 1)])  # type: ignore[arg-type]
    run.log({"a": 1}, step="x")  # type: ignore[arg-type]
    run.finish(timeout=0.5)
    run.log({"a": 1})  # after finish


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs os.fork")
def test_fork_child_gets_disabled_state(server):
    run = kymo.init(project="p", experiment="parent", host=server.url)
    run.log({"x": 1})
    assert run.flush(5)
    pid = os.fork()
    if pid == 0:  # child
        code = 1
        try:
            run.log({"x": 999})  # inherited run: no-op, must not deadlock
            kymo.log({"x": 999})
            assert run.flush(1) in (True, False)
            run.finish(timeout=1)
            child = kymo.init(project="p", experiment="child", host=server.url)
            child.log({"y": 7})
            assert child.flush(5)
            child.finish(timeout=5)
            code = 0
        except BaseException:
            import traceback

            traceback.print_exc()
        finally:
            os._exit(code)
    _, st = os.waitpid(pid, 0)
    assert os.WIFEXITED(st) and os.WEXITSTATUS(st) == 0
    run.log({"x": 2})
    assert run.flush(5)
    assert [p["metrics"]["x"] for p in server.points("parent")] == [1, 2]
    assert [p["metrics"] for p in server.points("child")] == [{"y": 7}]
    assert server.statuses("child") == ["running", "finished"]
    run.finish()
    assert server.statuses("parent") == ["running", "finished"]
