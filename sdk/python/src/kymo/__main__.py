"""Command line: ``python -m kymo sync`` replays the disk spool."""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from . import DEFAULT_HOST, _normalize_host
from ._sender import AUTH, DROP, GIVEUP, SPLIT, Batch, Sender, split_batch
from ._spool import Spool
from ._transport import Transport
from ._util import default_spool_dir, env_float, env_str


def _sync(args: argparse.Namespace) -> int:
    host = _normalize_host(args.host or env_str("KYMO_HOST", DEFAULT_HOST) or DEFAULT_HOST)
    if host is None:
        print("kymo: invalid host", file=sys.stderr)
        return 2
    key = args.api_key or env_str("KYMO_API_KEY")
    spool = Spool(args.dir or default_spool_dir(), host, key)
    files = spool.pending(all_hosts=args.all_hosts)
    if args.dry_run or not files:
        for f in files:
            print(f)
        print("kymo: %d spooled file(s) in %s for %s" % (len(files), spool.dir, host))
        return 0
    if not key:
        print("kymo: no API key (set KYMO_API_KEY or pass --api-key)", file=sys.stderr)
        return 2
    transport = Transport(host, key, timeout=env_float("KYMO_HTTP_TIMEOUT", 60.0))
    sender = Sender(transport, None, spool, replay=False)
    sender.max_failures = args.max_failures
    sent = dropped = failed = 0
    for path in files:
        got = spool.claim(path)
        if got is None:
            continue
        claimed, body = got
        queue: List[Batch] = [Batch(body, int(body.get("seq") or 0), "replay")]
        ok = True
        while queue:
            b = queue.pop(0)
            res = sender.deliver(b)
            if res == SPLIT:
                halves = split_batch(b)
                if halves:
                    queue[:0] = halves
                continue
            if res == DROP:
                dropped += 1
            elif res in (AUTH, GIVEUP):
                ok = False
                break
        if ok:
            Spool.remove(claimed)
            sent += 1
        else:
            Spool.release(claimed)
            failed += 1
            if res == AUTH:
                print("kymo: server rejected the API key; stopping", file=sys.stderr)
                break
            if res == GIVEUP:
                print("kymo: server unreachable; stopping (files kept)", file=sys.stderr)
                break
    transport.close()
    print("kymo: replayed %d file(s) to %s (%d rejected as malformed, %d kept)" % (sent, host, dropped, len(files) - sent))
    return 0 if failed == 0 else 1


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="python -m kymo", description="Kymo SDK utilities")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("sync", help="send spooled (unsent) data to the server")
    s.add_argument("--host", help="server URL (default $KYMO_HOST or %s)" % DEFAULT_HOST)
    s.add_argument("--api-key", help="API token (default $KYMO_API_KEY)")
    s.add_argument("--dir", help="spool directory (default $KYMO_CACHE_DIR or ~/.cache/kymo/spool)")
    s.add_argument("--all-hosts", action="store_true", help="also send files recorded for other hosts to --host")
    s.add_argument("--dry-run", action="store_true", help="only list the files that would be sent")
    s.add_argument("--max-failures", type=int, default=5, help="consecutive network failures before giving up")
    args = p.parse_args(argv)
    if args.cmd == "sync":
        return _sync(args)
    p.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
