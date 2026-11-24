"""Persistent HTTP(S) connection with urllib-compatible proxy support (stdlib only)."""

from __future__ import annotations

import base64
import http.client
import os
import socket
import ssl
import urllib.request
from typing import Dict, NamedTuple, Optional, Tuple
from urllib.parse import unquote, urlsplit

from ._version import __version__
from ._util import env_str, warn_once

USER_AGENT = "kymo-python/" + __version__

# Network-level failures that are worth a retry.
NETWORK_ERRORS = (OSError, http.client.HTTPException)


class ProxyInfo(NamedTuple):
    host: str
    port: int
    auth: Optional[str]  # value of the Proxy-Authorization header
    url: str  # for messages (without credentials)


def _parse_proxy(url: str) -> Optional[ProxyInfo]:
    if "://" not in url:
        url = "http://" + url
    p = urlsplit(url)
    scheme = p.scheme.lower()
    if scheme not in ("http", "https"):
        warn_once(("proxy-scheme", scheme), "proxy scheme %r is not supported (only http CONNECT/forward proxies); connecting directly", scheme)
        return None
    if not p.hostname:
        return None
    try:
        port = p.port or (443 if scheme == "https" else 80)
    except ValueError:
        return None
    auth = None
    if p.username is not None:
        cred = "%s:%s" % (unquote(p.username), unquote(p.password or ""))
        auth = "Basic " + base64.b64encode(cred.encode("utf-8")).decode("ascii")
    host = p.hostname
    return ProxyInfo(host, port, auth, "%s://%s:%d" % (scheme, host, port))


def resolve_proxy(scheme: str, netloc: str) -> Optional[ProxyInfo]:
    """Pick a proxy for ``scheme://netloc`` like urllib does.

    ``getproxies()`` reads ``<scheme>_proxy`` env vars in lower and upper case
    (lower case wins), ``proxy_bypass()`` applies ``no_proxy``.  ``ALL_PROXY``
    is used as a fallback, like curl/requests.
    """
    try:
        proxies = urllib.request.getproxies()
    except Exception:
        return None
    url = proxies.get(scheme) or proxies.get("all")
    if not url:
        return None
    try:
        if urllib.request.proxy_bypass(netloc):
            return None
    except Exception:
        pass
    return _parse_proxy(url)


def _ssl_context() -> ssl.SSLContext:
    cafile = env_str("KYMO_CA_BUNDLE")
    if cafile:
        return ssl.create_default_context(cafile=os.path.expanduser(cafile))
    return ssl.create_default_context()  # honors SSL_CERT_FILE / SSL_CERT_DIR


class Transport:
    """One keep-alive connection to the ingest server (optionally via a proxy).

    Not thread-safe: owned by the sender thread.  ``abort()`` may be called from
    another thread to unblock a pending request.
    """

    def __init__(self, base_url: str, api_key: Optional[str], timeout: float = 60.0, connect_timeout: float = 10.0):
        u = urlsplit(base_url)
        self.scheme = (u.scheme or "http").lower()
        if self.scheme not in ("http", "https"):
            raise ValueError("unsupported URL scheme %r" % self.scheme)
        if not u.hostname:
            raise ValueError("no host in %r" % base_url)
        self.host = u.hostname
        self.port = u.port or (443 if self.scheme == "https" else 80)
        self.netloc = u.netloc.rpartition("@")[2]
        self.prefix = u.path.rstrip("/")
        self.timeout = timeout
        self.connect_timeout = connect_timeout
        self.proxy = resolve_proxy(self.scheme, self.netloc)
        self.headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        if api_key:
            self.headers["Authorization"] = "Bearer " + api_key
        if self.proxy is not None and self.proxy.auth and self.scheme == "http":
            self.headers["Proxy-Authorization"] = self.proxy.auth
        self._conn: Optional[http.client.HTTPConnection] = None
        self._used = False
        self._ctx: Optional[ssl.SSLContext] = None

    def target(self, path: str) -> str:
        path = self.prefix + path
        if self.proxy is not None and self.scheme == "http":
            return "http://%s%s" % (self.netloc, path)  # absolute-URI form for forward proxies
        return path

    def _connect(self) -> http.client.HTTPConnection:
        conn: http.client.HTTPConnection
        if self.scheme == "https":
            if self._ctx is None:
                self._ctx = _ssl_context()
            if self.proxy is not None:
                conn = http.client.HTTPSConnection(self.proxy.host, self.proxy.port, timeout=self.connect_timeout, context=self._ctx)
                hdrs = {"User-Agent": USER_AGENT}
                if self.proxy.auth:
                    hdrs["Proxy-Authorization"] = self.proxy.auth
                conn.set_tunnel(self.host, self.port, headers=hdrs)
            else:
                conn = http.client.HTTPSConnection(self.host, self.port, timeout=self.connect_timeout, context=self._ctx)
        else:
            if self.proxy is not None:
                conn = http.client.HTTPConnection(self.proxy.host, self.proxy.port, timeout=self.connect_timeout)
            else:
                conn = http.client.HTTPConnection(self.host, self.port, timeout=self.connect_timeout)
        conn.connect()
        if conn.sock is not None:
            conn.sock.settimeout(self.timeout)
            try:
                conn.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
        self._conn = conn
        self._used = False
        return conn

    def post(self, path: str, body: bytes, extra: Optional[Dict[str, str]] = None) -> Tuple[int, Optional[str], bytes]:
        """POST and return (status, Retry-After header, body). Raises NETWORK_ERRORS."""
        headers = dict(self.headers)
        if extra:
            headers.update(extra)
        target = self.target(path)
        for attempt in (0, 1):
            conn = self._conn
            reused = conn is not None and self._used
            try:
                if conn is None or conn.sock is None:
                    self.close()
                    conn = self._connect()
                conn.request("POST", target, body=body, headers=headers)
                resp = conn.getresponse()
                data = resp.read()
            except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                self.close()
                if reused and attempt == 0:
                    continue  # stale keep-alive connection: retry once on a fresh one
                raise
            except BaseException:
                self.close()
                raise
            self._used = True
            if resp.will_close:
                self.close()
            return resp.status, resp.getheader("Retry-After"), data
        raise http.client.HTTPException("unreachable")  # pragma: no cover

    def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def abort(self) -> None:
        """Unblock a request in progress on another thread."""
        conn = self._conn
        sock = getattr(conn, "sock", None) if conn is not None else None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
