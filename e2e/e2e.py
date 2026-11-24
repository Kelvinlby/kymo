"""End-to-end test: real server + Python SDK + passkey ceremonies over HTTP.

Run against a fresh server:
    uv run --with requests,cbor2,cryptography python e2e/e2e.py --setup-token-file <data_dir>/setup_token
"""
from __future__ import annotations

import argparse
import os
import pathlib
import subprocess
import sys

import requests

from softpasskey import SoftPasskey

ROOT = pathlib.Path(__file__).resolve().parent.parent
ok_count = 0


def check(cond, msg):
    global ok_count
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)
    ok_count += 1
    print(f"ok   {msg}")


class Client:
    def __init__(self, host):
        self.host = host
        self.s = requests.Session()

    def req(self, method, path, json=None, csrf=True, **kw):
        headers = {"X-Kymo-CSRF": "1"} if csrf else {}
        return self.s.request(method, self.host + "/api/v1" + path, json=json, headers=headers, **kw)

    def passkey_register(self, pk: SoftPasskey, name="soft"):
        opts = self.req("POST", "/auth/passkey/register/start", {"name": name})
        assert opts.status_code == 200, opts.text
        r = self.req("POST", "/auth/passkey/register/finish", {"name": name, "credential": pk.register(opts.json())})
        return r

    def passkey_login(self, pk: SoftPasskey):
        opts = self.req("POST", "/auth/passkey/login/start")
        assert opts.status_code == 200, opts.text
        return self.req("POST", "/auth/passkey/login/finish", {"credential": pk.login(opts.json())})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="http://localhost:8080")
    ap.add_argument("--setup-token-file", required=True)
    ap.add_argument("--steps", type=int, default=50_000)
    a = ap.parse_args()
    H = a.host

    admin = Client(H)
    st = admin.req("GET", "/auth/state").json()
    check(st["setup_required"] is True, "fresh server requires setup")

    token = pathlib.Path(a.setup_token_file).read_text().strip()
    r = admin.req("POST", "/auth/setup", {"setup_token": "wrong", "username": "root", "password": "rootpassword1"})
    check(r.status_code in (401, 403), f"setup with wrong token rejected ({r.status_code})")
    r = admin.req("POST", "/auth/setup", {"setup_token": token, "username": "root", "password": "rootpassword1"})
    check(r.status_code == 200 and r.json()["state"] == "enroll_passkey", "setup -> admin must enroll passkey")
    r = admin.req("GET", "/tokens")
    check(r.status_code == 403 and r.json()["code"].startswith("session_"), "admin blocked before passkey enrollment")
    r = admin.req("POST", "/auth/setup", {"setup_token": token, "username": "x", "password": "rootpassword1"})
    check(r.status_code == 409, "setup cannot run twice")

    admin_pk = SoftPasskey("localhost", "http://localhost:8080")
    r = admin.passkey_register(admin_pk)
    check(r.status_code == 200, f"admin passkey registered ({r.text[:80]})")
    check(admin.req("GET", "/auth/state").json()["session_state"] == "full", "admin session is full after enrollment")

    r = admin.req("POST", "/tokens", {"name": "nocsrf"}, csrf=False)
    check(r.status_code == 403, "mutation without CSRF header rejected")
    r = admin.req("DELETE", f"/auth/passkeys/{admin.req('GET', '/auth/passkeys').json()[0]['id']}")
    check(r.status_code == 409, "admin cannot delete last passkey")

    # re-login requires passkey
    admin.req("POST", "/auth/logout")
    r = admin.req("POST", "/auth/login", {"username": "root", "password": "rootpassword1"})
    check(r.json()["state"] == "passkey_required", "admin login requires passkey")
    check(admin.req("GET", "/projects").status_code == 403, "half-logged-in admin cannot read")
    r = admin.passkey_login(admin_pk)
    check(r.status_code == 200 and r.json()["state"] == "full", "admin passkey login works")
    r = admin.req("POST", "/auth/login", {"username": "root", "password": "wrong-password"})
    check(r.status_code == 401, "wrong password rejected")
    admin.passkey_login(admin_pk) if admin.req("GET", "/auth/state").json()["session_state"] != "full" else None

    admin_token = admin.req("POST", "/tokens", {"name": "e2e"}).json()["token"]
    check(admin_token.startswith("kymo_"), "admin API token created")

    # invite-only signup
    anon = Client(H)
    r = anon.req("POST", "/auth/signup", {"invite_token": "nope", "username": "eve", "password": "evepassword1"})
    check(r.status_code >= 400, "signup without valid invite rejected")
    inv = admin.req("POST", "/admin/invites", {"username": "bob"}).json()
    check("/signup?invite=" in inv["url"], "admin created invite link")
    bob = Client(H)
    check(bob.req("GET", f"/auth/invite/{inv['token']}").json()["valid"], "invite is valid")
    r = bob.req("POST", "/auth/signup", {"invite_token": inv["token"], "username": "bob", "password": "bobpassword12"})
    check(r.status_code == 200 and r.json()["state"] == "full", "bob signed up (policy off -> no passkey needed)")
    r = anon.req("POST", "/auth/signup", {"invite_token": inv["token"], "username": "bob2", "password": "bobpassword12"})
    check(r.status_code >= 400, "invite cannot be reused")
    bob_token = bob.req("POST", "/tokens", {"name": "bob"}).json()["token"]

    # bearer token cannot do account/admin stuff
    t = requests.get(H + "/api/v1/admin/users", headers={"Authorization": f"Bearer {admin_token}"})
    check(t.status_code in (401, 403), "API token cannot call admin endpoints")
    t = requests.post(H + "/api/v1/tokens", json={"name": "x"}, headers={"Authorization": f"Bearer {admin_token}"})
    check(t.status_code in (401, 403), "API token cannot mint tokens")

    # SDK logging (3 runs from admin, 1 from bob), concurrently
    env = dict(os.environ, KYMO_HOST=H, KYMO_CACHE_DIR=str(ROOT / "e2e" / ".spool"))
    procs = []
    for exp, lr in [("7b-lr3e-4", "3e-4"), ("7b-lr1e-3", "1e-3"), ("7b-lr1e-4", "1e-4")]:
        procs.append(subprocess.Popen(
            ["uv", "run", "--project", str(ROOT / "sdk/python"), "python", str(ROOT / "e2e/train_fake.py"), exp, str(a.steps), lr],
            env=dict(env, KYMO_API_KEY=admin_token)))
    procs.append(subprocess.Popen(
        ["uv", "run", "--project", str(ROOT / "sdk/python"), "python", str(ROOT / "e2e/train_fake.py"), "bob-run", "5000"],
        env=dict(env, KYMO_API_KEY=bob_token)))
    for p in procs:
        check(p.wait(timeout=600) == 0, "SDK training process exited 0")

    projects = admin.req("GET", "/projects").json()
    mine = [p for p in projects if p["name"] == "e2e-llm" and p["owner"]["username"] == "root"]
    check(len(mine) == 1, "project auto-created by SDK")
    pid = mine[0]["id"]
    exps = admin.req("GET", f"/projects/{pid}/experiments").json()
    check(len(exps) == 3, "3 experiments auto-created")
    check(all(e["status"] == "finished" for e in exps), "experiments marked finished at exit")
    check(exps[0]["config"]["model"]["d_model"] == 4096, "config stored")
    eid = next(e["id"] for e in exps if e["name"] == "7b-lr3e-4")
    metrics = {m["key"]: m for m in admin.req("GET", f"/experiments/{eid}/metrics").json()}
    check(metrics["train/loss"]["count"] == a.steps, f"all {a.steps} train/loss points stored")
    check("layers/layer10/act_rms" in metrics and "is_warmup" in metrics, "nested keys flattened, bools kept")
    keys = list(metrics)
    check(keys.index("layers/layer2/act_rms") < keys.index("layers/layer10/act_rms"), "natural key sort")
    check(metrics["eval/acc"]["count"] == a.steps // 500, "sparse metric count correct")

    q = admin.req("POST", "/series/query", {"series": [{"experiment_id": e["id"], "key": "grad_norm"} for e in exps], "max_points": 1000}).json()
    s0 = q["series"][0]
    check(s0["downsampled"] and len(s0["step"]) <= 1000, "series downsampled to max_points")
    check(max(x for x in s0["max"] if x is not None) > 40, "spike preserved in max envelope")
    q = admin.req("POST", "/series/query", {"series": [{"experiment_id": eid, "key": "train/loss"}], "step_min": 1230, "step_max": 1240}).json()
    s = q["series"][0]
    check(not s["downsampled"] and len(s["step"]) == 11 and s["value"][s["step"].index(1234)] is None, "zoom window raw + NaN as null")

    # isolation
    bp = bob.req("GET", "/projects").json()
    check(all(p["owner"]["username"] == "bob" for p in bp), "bob only sees his projects")
    check(bob.req("GET", f"/experiments/{eid}/metrics").status_code in (403, 404), "bob cannot read admin experiment")
    admin.req("PATCH", f"/projects/{pid}", {"shared": True})
    check(bob.req("GET", f"/experiments/{eid}/metrics").status_code == 200, "shared project readable by bob")
    check(bob.req("PATCH", f"/experiments/{eid}", {"notes": "hi"}).status_code in (403, 404), "shared project not writable by bob")

    # site policy
    admin.req("PUT", "/admin/settings", {"passkey_required_for_all": True})
    bob2 = Client(H)
    r = bob2.req("POST", "/auth/login", {"username": "bob", "password": "bobpassword12"})
    check(r.json()["state"] == "enroll_passkey", "policy on -> bob must enroll passkey")
    admin.req("PUT", "/admin/settings", {"passkey_required_for_all": False})

    r = requests.get(H + "/p/1")
    check(r.status_code == 200 and "<html" in r.text.lower(), "SPA fallback serves index.html")
    print(f"\nALL {ok_count} CHECKS PASSED")


if __name__ == "__main__":
    main()
