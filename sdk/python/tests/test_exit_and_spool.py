import json
import os
import subprocess
import sys
import time

import kymo
from conftest import SRC, run_py, spool_files
from fakes import FakeIngest, free_port


def test_exit_flush_marks_finished(server):
    r = run_py(
        "run = kymo.init(project='p', experiment='exit', host=%r, flush_interval=60)\n"
        "for i in range(1000): run.log({'loss': i / 10}, step=i)\n" % server.url
    )
    assert r.returncode == 0, r.stderr
    pts = server.points("exit")
    assert sorted(p["step"] for p in pts) == list(range(1000))
    assert server.statuses("exit") == ["running", "finished"]


def test_uncaught_exception_marks_failed(server):
    r = run_py(
        "import sys\n"
        "seen = []\n"
        "sys.excepthook = lambda *a: seen.append(a)  # user hook installed before init is chained\n"
        "run = kymo.init(project='p', experiment='boom', host=%r)\n"
        "run.log({'loss': 1.0})\n"
        "import atexit; atexit.register(lambda: print('USERHOOK', len(seen)))\n"
        "raise RuntimeError('boom')\n" % server.url
    )
    assert r.returncode == 1
    assert "USERHOOK 1" in r.stdout
    assert server.statuses("boom")[-1] == "failed"
    assert len(server.points("boom")) == 1


def test_context_manager_failed(server):
    try:
        with kymo.init(project="p", experiment="ctx", host=server.url) as run:
            run.log({"x": 1})
            raise ValueError("x")
    except ValueError:
        pass
    assert server.statuses("ctx")[-1] == "failed"


def test_spool_when_server_down_then_replay_by_next_run(spool_dir):
    port = free_port()
    host = "http://127.0.0.1:%d" % port
    r = run_py(
        "import time\n"
        "run = kymo.init(project='p', experiment='down', host=%r, config={'a': 1})\n"
        "for i in range(50): run.log({'x': i})\n"
        "t = time.monotonic(); run.finish(timeout=10); print('FINISH', time.monotonic() - t)\n" % host
    )
    assert r.returncode == 0, r.stderr
    took = float(r.stdout.split("FINISH")[1])
    assert took < 5  # gives up quickly when the server is down
    files = spool_files(spool_dir)
    assert files
    env = json.loads(files[0].read_text())
    assert env["kymo_spool"] == 1 and env["host"] == host and "kymo_testtoken" not in files[0].read_text()
    bodies = [json.loads(f.read_text())["body"] for f in files]
    assert all(b.get("status") != "running" for b in bodies)  # never resurrect a finished run
    assert any(b.get("status") == "finished" for b in bodies)
    assert any(b.get("config") == {"a": 1} for b in bodies)

    srv = FakeIngest(port)
    try:
        run = kymo.init(project="p", experiment="later", host=host)
        assert srv.wait_for(lambda: len(srv.points("down")) == 50, 10)
        assert srv.wait_for(lambda: not spool_files(spool_dir), 5)
        assert "finished" in srv.statuses("down")
        run.finish()
    finally:
        srv.close()


def test_spool_replay_via_cli_sync(spool_dir):
    port = free_port()
    host = "http://127.0.0.1:%d" % port
    r = run_py("run = kymo.init(project='p', experiment='cli', host=%r)\n"
               "for i in range(7): run.log({'x': i})\n" % host, env={"KYMO_EXIT_TIMEOUT": "2"})
    assert r.returncode == 0, r.stderr
    assert spool_files(spool_dir)
    # a different token must not replay these files
    other = subprocess.run([sys.executable, "-m", "kymo", "sync", "--host", host, "--dry-run"],
                           env=dict(os.environ, PYTHONPATH=str(SRC), KYMO_API_KEY="kymo_other"),
                           capture_output=True, text=True)
    assert "0 spooled file(s)" in other.stdout
    srv = FakeIngest(port)
    try:
        s = subprocess.run([sys.executable, "-m", "kymo", "sync", "--host", host],
                           env=dict(os.environ, PYTHONPATH=str(SRC)), capture_output=True, text=True, timeout=30)
        assert s.returncode == 0, s.stdout + s.stderr
        assert sorted(p["metrics"]["x"] for p in srv.points("cli")) == list(range(7))
        assert srv.statuses("cli") == ["finished"]
        assert not spool_files(spool_dir)
    finally:
        srv.close()


def test_offline_mode_spools_only(server, spool_dir, monkeypatch):
    monkeypatch.setenv("KYMO_OFFLINE", "1")
    run = kymo.init(project="p", experiment="off", host=server.url, flush_interval=0.05)
    run.log({"x": 1})
    run.finish()
    assert server.requests == []
    bodies = [json.loads(f.read_text())["body"] for f in spool_files(spool_dir)]
    assert [p["metrics"] for b in bodies for p in b["points"]] == [{"x": 1}]


def test_missing_api_key_goes_offline(server, spool_dir, monkeypatch):
    monkeypatch.delenv("KYMO_API_KEY")
    run = kymo.init(project="p", experiment="nokey", host=server.url)
    run.log({"x": 1})
    run.finish()
    assert server.requests == []
    files = spool_files(spool_dir)
    assert files and all(f.name.endswith("-anon.json") for f in files)


def test_disabled(server, monkeypatch):
    monkeypatch.setenv("KYMO_DISABLED", "1")
    run = kymo.init(project="p", experiment="dis", host=server.url)
    assert isinstance(run, kymo.NoopRun)
    run.log({"x": 1})
    kymo.log({"x": 2})
    run.finish()
    time.sleep(0.1)
    assert server.requests == []


def test_enabled_flag_and_no_env_autodetection(server, monkeypatch):
    off = kymo.init(project="p", experiment="en-off", host=server.url, enabled=False)
    assert isinstance(off, kymo.NoopRun)
    off.log({"x": 1})
    kymo.log({"x": 1})  # targets the no-op run
    # launcher-style env vars are ignored: every process that calls init logs
    for name in ("RANK", "LOCAL_RANK", "WORLD_SIZE"):
        monkeypatch.setenv(name, "3")
    run = kymo.init(project="p", experiment="en-on", host=server.url)
    assert not isinstance(run, kymo.NoopRun)
    run.log({"loss": 1, "eval": {"acc": 2}})
    assert run.flush(5)
    assert server.points("en-on")[0]["metrics"] == {"loss": 1, "eval/acc": 2}
    assert not [b for b in server.ok_bodies() if b["experiment"] == "en-off"]


def test_module_level_shortcuts(server):
    kymo.init(project="p", experiment="mod", host=server.url)
    kymo.log({"x": 1}, step=5)
    assert kymo.flush(5)
    kymo.finish()
    assert server.points("mod")[0]["step"] == 5
    assert server.statuses("mod")[-1] == "finished"
    kymo.log({"x": 2})  # after finish: silently ignored
