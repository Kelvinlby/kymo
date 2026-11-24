"""Stdlib-only test doubles: a fake ingest server, a forwarding/CONNECT proxy,
and a server that accepts connections but never answers."""

from __future__ import annotations

import base64
import gzip
import http.client
import json
import socket
import socketserver
import ssl
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple, Union
from urllib.parse import urlsplit

Script = Union[int, Tuple[int, Dict[str, str]]]


class _IngestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: "_Server"

    def setup(self) -> None:
        super().setup()
        with self.server.fake.lock:
            self.server.fake.connections += 1

    def log_message(self, *a: Any) -> None:
        pass

    def do_POST(self) -> None:
        fake = self.server.fake
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        gz = self.headers.get("Content-Encoding") == "gzip"
        data = gzip.decompress(raw) if gz else raw
        try:
            body = json.loads(data)
        except Exception:
            body = None
        with fake.lock:
            if fake.script:
                item = fake.script.popleft()
            else:
                item = 200
        status, extra = (item, {}) if isinstance(item, int) else item
        nvalues = sum(len(p.get("metrics") or {}) for p in (body or {}).get("points") or [])
        if status == 200 and fake.max_values is not None and nvalues > fake.max_values:
            status = 413
        rec = {"path": self.path, "headers": dict(self.headers), "gz": gz, "raw": data, "body": body, "status": status}
        with fake.lock:
            fake.requests.append(rec)
        if status == 200:
            out = {"ok": True, "experiment_id": 1, "accepted": nvalues, "dropped": 0}
        else:
            out = {"error": "scripted", "code": "scripted"}
        payload = json.dumps(out).encode()
        self.send_response(status)
        for k, v in extra.items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    fake: "FakeIngest"


class FakeIngest:
    def __init__(self, port: int = 0, tls: Optional[ssl.SSLContext] = None):
        self.lock = threading.Lock()
        self.requests: List[dict] = []
        self.script: Deque[Script] = deque()
        self.max_values: Optional[int] = None
        self.connections = 0
        self.srv = _Server(("127.0.0.1", port), _IngestHandler)
        self.srv.fake = self
        if tls is not None:
            self.srv.socket = tls.wrap_socket(self.srv.socket, server_side=True)
        self.port = self.srv.server_address[1]
        self.scheme = "https" if tls is not None else "http"
        self.thread = threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        host = "localhost" if self.scheme == "https" else "127.0.0.1"
        return "%s://%s:%d" % (self.scheme, host, self.port)

    def close(self) -> None:
        self.srv.shutdown()
        self.srv.server_close()

    def ok_bodies(self) -> List[dict]:
        with self.lock:
            return [r["body"] for r in self.requests if r["status"] == 200 and r["body"] is not None]

    def points(self, experiment: Optional[str] = None) -> List[dict]:
        out = []
        for b in self.ok_bodies():
            if experiment is None or b.get("experiment") == experiment:
                out.extend(b.get("points") or [])
        return out

    def statuses(self, experiment: Optional[str] = None) -> List[str]:
        return [b["status"] for b in self.ok_bodies() if "status" in b and (experiment is None or b.get("experiment") == experiment)]

    def wait_for(self, pred: Callable[[], bool], timeout: float = 10.0) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if pred():
                return True
            time.sleep(0.02)
        return pred()


# ----------------------------------------------------------------------- proxy
def _pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            b = src.recv(65536)
            if not b:
                break
            dst.sendall(b)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class _ProxyHandler(socketserver.StreamRequestHandler):
    server: "_ProxyServer"

    def handle(self) -> None:
        fp = self.server.fake
        upstream: Optional[http.client.HTTPConnection] = None
        while True:
            line = self.rfile.readline(65537)
            if not line:
                return
            try:
                method, target, _ver = line.decode("latin-1").strip().split(" ", 2)
            except ValueError:
                return
            headers: Dict[str, str] = {}
            while True:
                h = self.rfile.readline(65537).decode("latin-1")
                if h in ("\r\n", "\n", ""):
                    break
                k, _, v = h.partition(":")
                headers[k.strip()] = v.strip()
            auth = next((v for k, v in headers.items() if k.lower() == "proxy-authorization"), None)
            with fp.lock:
                fp.seen.append((method, target, auth))
            if fp.auth is not None and auth != "Basic " + base64.b64encode(fp.auth.encode()).decode():
                self.wfile.write(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nContent-Length: 0\r\n\r\n")
                if method == "CONNECT":
                    return
                n = int(next((v for k, v in headers.items() if k.lower() == "content-length"), "0"))
                self.rfile.read(n)
                continue
            if method == "CONNECT":
                host, _, port = target.rpartition(":")
                up = socket.create_connection((host, int(port)))
                self.wfile.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
                self.wfile.flush()
                t = threading.Thread(target=_pipe, args=(up, self.connection), daemon=True)
                t.start()
                # the client waits for our 200 before sending, so rfile's buffer is empty here
                _pipe(self.connection, up)
                t.join(5)
                return
            # forward proxy: absolute-URI request line
            u = urlsplit(target)
            if not u.scheme:
                self.wfile.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                return
            n = int(next((v for k, v in headers.items() if k.lower() == "content-length"), "0"))
            body = self.rfile.read(n)
            if upstream is None:
                upstream = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=10)
            fwd = {k: v for k, v in headers.items() if not k.lower().startswith("proxy-")}
            upstream.request(method, u.path + ("?" + u.query if u.query else ""), body=body, headers=fwd)
            resp = upstream.getresponse()
            data = resp.read()
            out = ["HTTP/1.1 %d %s" % (resp.status, resp.reason)]
            for k, v in resp.getheaders():
                if k.lower() not in ("content-length", "connection", "transfer-encoding"):
                    out.append("%s: %s" % (k, v))
            out.append("Content-Length: %d" % len(data))
            self.wfile.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1") + data)
            self.wfile.flush()


class _ProxyServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    fake: "FakeProxy"


class FakeProxy:
    def __init__(self, auth: Optional[str] = None):
        self.lock = threading.Lock()
        self.auth = auth
        self.seen: List[Tuple[str, str, Optional[str]]] = []
        self.srv = _ProxyServer(("127.0.0.1", 0), _ProxyHandler)
        self.srv.fake = self
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.srv.shutdown()
        self.srv.server_close()


# ---------------------------------------------------------------------- hanger
class HangingServer:
    """Accepts TCP connections and never sends a byte."""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(128)
        self.port = self.sock.getsockname()[1]
        self.conns: List[socket.socket] = []
        self._stop = False
        self.thread = threading.Thread(target=self._accept, daemon=True)
        self.thread.start()

    def _accept(self) -> None:
        self.sock.settimeout(0.1)
        while not self._stop:
            try:
                c, _ = self.sock.accept()
                self.conns.append(c)
            except socket.timeout:
                continue
            except OSError:
                return

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d" % self.port

    def close(self) -> None:
        self._stop = True
        for c in self.conns:
            c.close()
        self.sock.close()


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


if __name__ == "__main__":  # standalone fake server for bench/
    srv = FakeIngest(int(sys.argv[1]) if len(sys.argv) > 1 else 0)
    print(srv.port, flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
