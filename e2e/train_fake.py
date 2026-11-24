"""Fake training loop using the kymo SDK. Usage: KYMO_API_KEY=... KYMO_HOST=... python train_fake.py <experiment> <steps>"""
import math
import random
import sys
import time

import kymo

exp, steps = sys.argv[1], int(sys.argv[2])
lr = float(sys.argv[3]) if len(sys.argv) > 3 else 3e-4
run = kymo.init(project="e2e-llm", experiment=exp, config={"lr": lr, "model": {"d_model": 4096, "layers": 32}})

t0 = time.perf_counter()
worst = 0.0
for step in range(steps):
    loss = 2.0 + 8.0 * math.exp(-step / (steps / 5)) * (lr / 3e-4) ** -0.3 + random.gauss(0, 0.05)
    metrics = {
        "train": {"loss": loss, "ppl": math.exp(min(loss, 20))},
        "lr": lr * min(1.0, step / 1000),
        "grad_norm": abs(random.gauss(1, 0.3)) + (50.0 if step % 9973 == 0 else 0.0),
        "is_warmup": step < 1000,
    }
    for layer in range(16):
        metrics[f"layers/layer{layer}/act_rms"] = 1.0 + layer * 0.1 + random.gauss(0, 0.01)
    if step % 500 == 0:
        metrics["eval/acc"] = 1 - math.exp(-step / steps * 3)
    if step == 1234:
        metrics["train"]["loss"] = float("nan")
    s = time.perf_counter()
    run.log(metrics, step=step)
    worst = max(worst, time.perf_counter() - s)
elapsed = time.perf_counter() - t0
print(f"{exp}: {steps} steps logged in {elapsed:.3f}s  ({elapsed / steps * 1e6:.2f} us/step incl. metric gen, worst log() {worst * 1e6:.0f} us)")
f0 = time.perf_counter()
run.finish()
print(f"{exp}: finish() took {time.perf_counter() - f0:.2f}s")
