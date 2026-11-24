"""Seed a fresh Kymo server with demo accounts and runs.

uv run --with requests,cbor2,cryptography python demo/seed.py --data-dir demo/data
Writes demo/CREDENTIALS.md (gitignored) with the demo login and API token.
"""
import argparse
import os
import pathlib
import secrets
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "e2e"))
from e2e import Client  # noqa: E402
from softpasskey import SoftPasskey  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--host", default="http://localhost:8080")
ap.add_argument("--data-dir", required=True)
a = ap.parse_args()

admin = Client(a.host)
setup_token = (pathlib.Path(a.data_dir) / "setup_token").read_text().strip()
admin_pw = secrets.token_urlsafe(12)
r = admin.req("POST", "/auth/setup", {"setup_token": setup_token, "username": "admin", "password": admin_pw, "display_name": "Admin (demo)"})
r.raise_for_status()
assert admin.passkey_register(SoftPasskey("localhost", a.host), "demo soft key").status_code == 200

inv = admin.req("POST", "/admin/invites", {"username": "demo"}).json()
demo = Client(a.host)
demo_pw = secrets.token_urlsafe(9)
demo.req("POST", "/auth/signup", {"invite_token": inv["token"], "username": "demo", "password": demo_pw, "display_name": "Demo User"}).raise_for_status()
token = demo.req("POST", "/tokens", {"name": "demo seeding"}).json()["token"]
spare = admin.req("POST", "/admin/invites", {"expires_hours": 168}).json()

creds = ROOT / "demo" / "CREDENTIALS.md"
creds.write_text(
    f"# Kymo demo credentials (local demo only)\n\n"
    f"- URL: {a.host}\n- Demo user: `demo` / `{demo_pw}`\n- Demo user API token: `{token}`\n"
    f"- Admin: `admin` / `{admin_pw}` — passkey is a software key held only by the seed script, so the admin "
    f"can't log in from a browser. For a real admin, start a fresh data dir and run /setup yourself.\n"
    f"- Spare invite link (create your own user): {spare['url']}\n"
)
os.chmod(creds, 0o600)

env = dict(os.environ, KYMO_HOST=a.host, KYMO_API_KEY=token, KYMO_CACHE_DIR=str(ROOT / "demo" / ".spool"))
py = ["uv", "run", "-q", "--project", str(ROOT / "sdk/python"), "python", str(ROOT / "demo/train_demo.py")]
jobs = [
    ["llm-pretrain", "70b-lr3e-4-baseline", "100000", "--lr", "3e-4", "--seed", "1"],
    ["llm-pretrain", "70b-lr1e-4", "100000", "--lr", "1e-4", "--seed", "2"],
    ["llm-pretrain", "70b-lr6e-4", "100000", "--lr", "6e-4", "--seed", "3"],
    ["llm-pretrain", "70b-lr1e-3-diverged", "60000", "--lr", "1e-3", "--seed", "4", "--diverge", "40000"],
    ["llm-pretrain", "70b-lr2e-4-long", "250000", "--lr", "2e-4", "--seed", "5"],
    ["vision-finetune", "vit-l-lr1e-3", "20000", "--lr", "1e-3", "--seed", "6", "--vision"],
    ["vision-finetune", "vit-l-lr3e-4", "20000", "--lr", "3e-4", "--seed", "7", "--vision"],
    ["vision-finetune", "vit-l-lr1e-4", "20000", "--lr", "1e-4", "--seed", "8", "--vision"],
]
procs = [subprocess.Popen(py + j, env=env) for j in jobs]
for p in procs:
    p.wait()

pid = next(p["id"] for p in demo.req("GET", "/projects").json() if p["name"] == "llm-pretrain")
for e in demo.req("GET", f"/projects/{pid}/experiments").json():
    if "diverged" in e["name"]:
        demo.req("PATCH", f"/experiments/{e['id']}", {"status": "failed", "tags": ["diverged", "lr-sweep"], "notes": "Loss blew up after step 40k."})
    else:
        demo.req("PATCH", f"/experiments/{e['id']}", {"tags": ["lr-sweep"]})
demo.req("PATCH", f"/projects/{pid}", {"description": "70B pretraining LR sweep (synthetic demo data)"})
print("seeded; credentials in", creds)
