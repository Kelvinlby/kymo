from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, Iterator, Optional

import pytest

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "src"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(SRC))

import kymo  # noqa: E402
import kymo._sender  # noqa: E402
from fakes import FakeIngest, FakeProxy, HangingServer  # noqa: E402

_PROXY_VARS = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Path]:
    for v in _PROXY_VARS:
        monkeypatch.delenv(v, raising=False)
        monkeypatch.delenv(v.upper(), raising=False)
    for v in list(os.environ):
        if v.startswith("KYMO_"):
            monkeypatch.delenv(v, raising=False)
    spool = tmp_path / "spool"
    monkeypatch.setenv("KYMO_CACHE_DIR", str(spool))
    monkeypatch.setenv("KYMO_API_KEY", "kymo_testtoken")
    monkeypatch.setattr(kymo._sender, "BACKOFF_BASE", 0.02)
    monkeypatch.setattr(kymo._sender, "BACKOFF_CAP", 0.2)
    yield spool
    kymo._finish_all(timeout=2.0)


@pytest.fixture
def spool_dir(clean_env: Path) -> Path:
    return clean_env


@pytest.fixture
def server() -> Iterator[FakeIngest]:
    s = FakeIngest()
    yield s
    s.close()


@pytest.fixture
def proxy() -> Iterator[FakeProxy]:
    p = FakeProxy()
    yield p
    p.close()


@pytest.fixture
def hanging() -> Iterator[HangingServer]:
    h = HangingServer()
    yield h
    h.close()


def spool_files(d: Path):
    return sorted(p for p in d.glob("*.json")) if d.exists() else []


def run_py(code: str, env: Optional[Dict[str, str]] = None, timeout: float = 60) -> subprocess.CompletedProcess:
    """Run a snippet in a fresh interpreter with the SDK importable."""
    e = dict(os.environ)
    e["PYTHONPATH"] = os.pathsep.join([str(SRC), str(HERE)])
    if env:
        e.update(env)
    prelude = "import kymo, kymo._sender as _s\n_s.BACKOFF_BASE = 0.02\n_s.BACKOFF_CAP = 0.2\n"
    return subprocess.run([sys.executable, "-c", prelude + code], env=e, capture_output=True, text=True, timeout=timeout)


def make_cert(tmp: Path) -> Optional[Path]:
    """Self-signed cert for localhost/127.0.0.1 (needs the openssl CLI)."""
    if shutil.which("openssl") is None:
        return None
    key, crt = tmp / "key.pem", tmp / "cert.pem"
    r = subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(crt),
         "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
        capture_output=True,
    )
    if r.returncode != 0:
        return None
    (tmp / "both.pem").write_bytes(crt.read_bytes() + key.read_bytes())
    return tmp
