"""Disk spool: unsent ingest bodies as JSON files, replayed later.

File name: ``<time_ns>-<pid>-<seq>-<hostkey>-<tokenkey>.json`` so a replayer can
pick its own files without opening them.  ``tokenkey`` is a short sha256 of the
API key (never the key itself) or ``anon`` when the run had no key; anon files
are sent with whatever key the replayer has.

Content: ``{"kymo_spool": 1, "host": ..., "token": ..., "created": ..., "body": <ingest body>}``.

A replayer claims a file by renaming it to ``<name>.claimed.<pid>`` (atomic, so
only one process wins), deletes it after a 2xx, renames it back otherwise.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from typing import List, Optional, Tuple

from ._encode import dumps
from ._util import warn_once

SUFFIX = ".json"
CLAIM = ".claimed."


def token_key(api_key: Optional[str]) -> str:
    if not api_key:
        return "anon"
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]


def host_key(host: str) -> str:
    return hashlib.sha256(host.rstrip("/").encode("utf-8")).hexdigest()[:10]


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except Exception:
        return True
    return True


class Spool:
    def __init__(self, directory: str, host: str, api_key: Optional[str]):
        self.dir = directory
        self.host = host.rstrip("/")
        self.hkey = host_key(self.host)
        self.tkey = token_key(api_key)
        self._made = False
        self._n = 0

    # ------------------------------------------------------------------ write
    def write(self, raw_body: bytes, seq: int = 0) -> Optional[str]:
        """Atomically write one ingest body (uncompressed JSON bytes). Never raises."""
        try:
            if not self._made:
                os.makedirs(self.dir, mode=0o700, exist_ok=True)
                self._made = True
            self._n += 1
            name = "%020d-%d-%06d-%d-%s-%s%s" % (time.time_ns(), os.getpid(), seq, self._n, self.hkey, self.tkey, SUFFIX)
            path = os.path.join(self.dir, name)
            head = dumps({"kymo_spool": 1, "host": self.host, "token": self.tkey, "created": time.time()})
            data = head[:-1] + b',"body":' + raw_body + b"}"
            tmp = path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            os.replace(tmp, path)
            return path
        except Exception as e:
            warn_once(("spool-write", type(e).__name__), "cannot write spool file in %s (%s); data is lost", self.dir, e)
            return None

    # ------------------------------------------------------------------- read
    def pending(self, all_hosts: bool = False) -> List[str]:
        """Sorted list of spool files this replayer may send (also recovers dead claims)."""
        try:
            names = os.listdir(self.dir)
        except OSError:
            return []
        out = []
        for n in names:
            if CLAIM in n:
                self._recover_claim(n)
                n = n.split(CLAIM, 1)[0]
                if not os.path.exists(os.path.join(self.dir, n)):
                    continue
            if not n.endswith(SUFFIX):
                continue
            parts = n[: -len(SUFFIX)].split("-")
            if len(parts) < 6:
                continue
            hk, tk = parts[-2], parts[-1]
            if not all_hosts and hk != self.hkey:
                continue
            if tk != self.tkey and tk != "anon":
                continue
            out.append(n)
        out.sort()
        return [os.path.join(self.dir, n) for n in out]

    def _recover_claim(self, name: str) -> None:
        base, _, pid = name.rpartition(CLAIM)
        try:
            if int(pid) == os.getpid() or _pid_alive(int(pid)):
                return
            os.rename(os.path.join(self.dir, name), os.path.join(self.dir, base))
        except (ValueError, OSError):
            pass

    def claim(self, path: str) -> Optional[Tuple[str, dict]]:
        """Claim a file; return (claimed_path, ingest body dict) or None."""
        claimed = path + CLAIM + str(os.getpid())
        try:
            os.rename(path, claimed)
        except OSError:
            return None  # somebody else got it
        try:
            with open(claimed, "rb") as f:
                env = json.loads(f.read())
            body = env["body"]
            if not isinstance(body, dict):
                raise ValueError("body is not an object")
            return claimed, body
        except Exception as e:
            warn_once(("spool-bad", path), "corrupt spool file %s (%s); renamed to .bad", path, e)
            try:
                os.rename(claimed, path[: -len(SUFFIX)] + ".bad")
            except OSError:
                pass
            return None

    @staticmethod
    def release(claimed: str) -> None:
        try:
            os.rename(claimed, claimed.split(CLAIM, 1)[0])
        except OSError:
            pass

    @staticmethod
    def remove(claimed: str) -> None:
        try:
            os.unlink(claimed)
        except OSError:
            pass
