"""Benchmark the log() hot path.

    cd sdk/python && uv run python bench/bench_log.py

Starts the fake ingest server from tests/fakes.py in a separate process so the
background threads really batch, gzip and POST while the loop runs (they
compete for the GIL, as in real training).
"""

from __future__ import annotations

import os
import statistics
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

import kymo  # noqa: E402

N = 200_000
REPEATS = 7


def per_call(fn, n=N) -> float:
    samples = []
    for _ in range(REPEATS):
        t0 = time.perf_counter()
        fn(n)
        samples.append((time.perf_counter() - t0) / n * 1e6)
    return statistics.median(samples), min(samples)


def main() -> None:
    srv = subprocess.Popen([sys.executable, str(HERE.parent / "tests" / "fakes.py")], stdout=subprocess.PIPE, text=True)
    port = int(srv.stdout.readline())
    os.environ.setdefault("KYMO_CACHE_DIR", str(HERE / ".bench-spool"))
    try:
        run = kymo.init(project="bench", experiment="hot-path", api_key="kymo_bench", host="http://127.0.0.1:%d" % port)
        d10 = {"train/loss": 2.31, "train/acc": 0.5, "lr": 3e-4, "grad_norm": 1.2, "tokens": 123456,
               "a": 1.0, "b": 2.0, "c": 3.0, "d": 4.0, "e": 5.0}
        nested = {"train": {"loss": 2.31, "acc": 0.5}, "eval": {"loss": 2.4, "acc": 0.49}, "lr": 3e-4,
                  "a": 1.0, "b": 2.0, "c": 3.0, "d": 4.0, "e": 5.0}
        step = [0]

        def with_step(n):
            log = run.log
            s = step[0]
            for i in range(s, s + n):
                log(d10, step=i)
            step[0] = s + n

        def no_step(n):
            log = run.log
            for _ in range(n):
                log(d10)

        def nested_dict(n):
            log = run.log
            for _ in range(n):
                log(nested)

        def module_level(n):
            log = kymo.log
            for _ in range(n):
                log(d10)

        q: deque = deque()

        def baseline(n):
            app, tt = q.append, time.time
            for i in range(n):
                app((i, tt(), d10.copy()))
            q.clear()

        def empty_loop(n):
            for _ in range(n):
                pass

        results = {}
        for name, fn in [("empty loop", empty_loop), ("baseline: copy+append", baseline),
                         ("run.log(d10, step=i)", with_step), ("run.log(d10)", no_step),
                         ("run.log(nested 10 values)", nested_dict), ("kymo.log(d10)", module_level)]:
            results[name] = per_call(fn)
            run.flush(120)  # let the background catch up between measurements

        total = step[0] + 3 * REPEATS * N
        t0 = time.perf_counter()
        for i in range(100_000):
            run.log(d10)
        t_log = time.perf_counter() - t0
        ok = run.flush(300)
        t_all = time.perf_counter() - t0
        run.finish()

        print("Python %s, %s" % (sys.version.split()[0], os.uname().machine))
        print("%-28s %10s %10s" % ("case", "median us", "min us"))
        for name, (med, mn) in results.items():
            print("%-28s %10.3f %10.3f" % (name, med, mn))
        print("background throughput: 100k points x 10 keys logged in %.3f s, delivered (convert+JSON+gzip+POST+ack) "
              "in %.3f s -> %.0f points/s (flush ok=%s); %d points total" % (t_log, t_all, 100_000 / t_all, ok, total))
    finally:
        srv.terminate()
        srv.wait()


if __name__ == "__main__":
    main()
