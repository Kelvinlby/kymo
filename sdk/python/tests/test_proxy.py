import base64
import ssl

import pytest

import kymo
from conftest import make_cert
from fakes import FakeIngest, FakeProxy


def test_http_through_forward_proxy_with_basic_auth(server, monkeypatch):
    px = FakeProxy(auth="alice:s3cr@t")
    try:
        monkeypatch.setenv("HTTP_PROXY", "http://alice:s3cr%%40t@127.0.0.1:%d" % px.port)
        run = kymo.init(project="p", experiment="px", host=server.url)
        run.log({"x": 1})
        assert run.flush(5)
        run.log({"x": 2})
        assert run.flush(5)
        want = "Basic " + base64.b64encode(b"alice:s3cr@t").decode()
        assert px.seen and all(m == "POST" for m, _, _ in px.seen)
        assert all(t == server.url + "/api/v1/ingest" for _, t, _ in px.seen)  # absolute-URI request line
        assert all(a == want for _, _, a in px.seen)
        assert [p["metrics"] for p in server.points("px")] == [{"x": 1}, {"x": 2}]
        assert server.connections == 1  # proxy keeps one upstream connection: client used keep-alive
        assert not any("Proxy-Authorization" in r["headers"] for r in server.requests)  # not leaked upstream
    finally:
        px.close()


def test_lowercase_and_all_proxy(server, proxy, monkeypatch):
    monkeypatch.setenv("all_proxy", "127.0.0.1:%d" % proxy.port)  # scheme-less, like curl accepts
    run = kymo.init(project="p", experiment="allpx", host=server.url)
    run.log({"x": 1})
    assert run.flush(5)
    assert proxy.seen


def test_no_proxy_bypass(server, proxy, monkeypatch):
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:%d" % proxy.port)
    monkeypatch.setenv("NO_PROXY", "example.com,127.0.0.1")
    run = kymo.init(project="p", experiment="nopx", host=server.url)
    run.log({"x": 1})
    assert run.flush(5)
    assert proxy.seen == []
    assert len(server.points("nopx")) == 1


def test_wrong_proxy_auth_retries_without_crashing(server, monkeypatch):
    px = FakeProxy(auth="alice:right")
    try:
        monkeypatch.setenv("HTTP_PROXY", "http://alice:wrong@127.0.0.1:%d" % px.port)
        run = kymo.init(project="p", experiment="407", host=server.url)
        run.log({"x": 1})
        assert not run.flush(0.5)  # 407 is retried, nothing delivered
        assert server.requests == []
        run.finish(timeout=1)
    finally:
        px.close()


def test_https_connect_tunnel(tmp_path, monkeypatch):
    certs = make_cert(tmp_path)
    if certs is None:
        pytest.skip("openssl CLI not available")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(certs / "cert.pem"), str(certs / "key.pem"))
    srv = FakeIngest(tls=ctx)
    px = FakeProxy(auth="bob:pw")
    try:
        monkeypatch.setenv("KYMO_CA_BUNDLE", str(certs / "cert.pem"))
        monkeypatch.setenv("HTTPS_PROXY", "http://bob:pw@127.0.0.1:%d" % px.port)
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")  # must not be used for https
        run = kymo.init(project="p", experiment="tls", host=srv.url)
        run.log({"x": 1})
        assert run.flush(10)
        run.log({"x": 2})
        assert run.flush(10)
        want = "Basic " + base64.b64encode(b"bob:pw").decode()
        connects = [s for s in px.seen if s[0] == "CONNECT"]
        assert connects == [("CONNECT", "localhost:%d" % srv.port, want)]  # one tunnel, reused (keep-alive)
        assert [p["metrics"] for p in srv.points("tls")] == [{"x": 1}, {"x": 2}]
    finally:
        px.close()
        srv.close()
