"""Synthetic training run for the demo site.

python train_demo.py <project> <experiment> <steps> [--lr X] [--live STEPS_PER_SEC] [--seed N] [--vision]
"""
import argparse
import math
import random
import time

import kymo

ap = argparse.ArgumentParser()
ap.add_argument("project")
ap.add_argument("experiment")
ap.add_argument("steps", type=int)
ap.add_argument("--lr", type=float, default=3e-4)
ap.add_argument("--live", type=float, default=0.0, help="steps per second; 0 = as fast as possible")
ap.add_argument("--seed", type=int, default=0)
ap.add_argument("--vision", action="store_true")
ap.add_argument("--diverge", type=int, default=0, help="step at which the loss blows up (0 = never)")
a = ap.parse_args()
rng = random.Random(a.seed)

if a.vision:
    cfg = {"lr": a.lr, "model": "vit-l/16", "batch_size": 1024, "optimizer": "lion", "augment": "randaug", "epochs": 90}
else:
    cfg = {"lr": a.lr, "model": {"params": "70B", "d_model": 8192, "layers": 80, "heads": 64},
           "batch_tokens": 4_194_304, "optimizer": "adamw", "warmup": 2000, "schedule": "cosine", "dtype": "bf16"}
run = kymo.init(project=a.project, experiment=a.experiment, config=cfg)

N = a.steps
warm = max(1, N // 50)
quality = (a.lr / 3e-4) ** 0.25 if a.lr <= 3e-4 else (3e-4 / a.lr) ** 0.6
floor = 1.7 + 0.25 * (1 - quality) + rng.uniform(-0.03, 0.03)
ema_noise = 0.0
step = 0
while True:
    if a.live == 0 and step >= N:
        break
    t = step / N if a.live == 0 else step / (step + 20000)
    sched = min(1.0, step / warm) * (0.5 * (1 + math.cos(math.pi * min(t, 1.0))) * 0.9 + 0.1)
    lr = a.lr * sched
    ema_noise = 0.98 * ema_noise + 0.02 * rng.gauss(0, 1)
    loss = floor + 9.0 * math.exp(-6 * t * quality) + 0.04 * rng.gauss(0, 1) + 0.03 * ema_noise
    spike = rng.random() < 0.0004
    if spike:
        loss += rng.uniform(0.5, 3)
    if a.diverge and step > a.diverge:
        loss += 0.002 * (step - a.diverge) ** 1.3
    m = {"train": {"loss": loss, "lr": lr, "grad_norm": abs(rng.gauss(0.8, 0.15)) * (8 if spike else 1) + 4 * math.exp(-10 * t)},
         "perf": {"tokens_per_sec": 2.1e6 * (1 + 0.02 * rng.gauss(0, 1)), "mfu": 0.52 + 0.01 * rng.gauss(0, 1),
                  "gpu_mem_gb": 71.3 + 0.2 * rng.random()}}
    if a.vision:
        m["train"]["top1"] = min(0.99, (1 - math.exp(-5 * t)) * 0.88 * quality + 0.005 * rng.gauss(0, 1))
    for layer in (0, 10, 20, 40, 60, 79):
        m[f"layers/layer{layer}/act_rms"] = 1 + 0.02 * layer * (1 - math.exp(-3 * t)) + 0.01 * rng.gauss(0, 1)
        m[f"layers/layer{layer}/grad_rms"] = 1e-3 * (1 + layer / 40) * math.exp(-2 * t) * (1 + 0.1 * rng.gauss(0, 1))
    if step % 250 == 0:
        m["eval"] = {"loss": loss + 0.05 + 0.02 * rng.gauss(0, 1), "ppl": math.exp(min(loss + 0.05, 30)),
                     "hellaswag": max(0.25, min(0.9, 0.25 + 0.6 * (1 - math.exp(-4 * t)) * quality))}
    run.log(m, step=step)
    step += 1
    if a.live:
        time.sleep(1 / a.live)
run.finish()
