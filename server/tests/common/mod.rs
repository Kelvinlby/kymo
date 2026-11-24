#![allow(dead_code)]
use kymo_server::{RunningServer, config::Config};
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_rs::prelude::{CreationChallengeResponse, RequestChallengeResponse, Url};

pub const ORIGIN: &str = "http://localhost:8080";
pub const ADMIN_PW: &str = "correct horse battery";

pub struct Harness {
    pub server: Option<RunningServer>,
    pub dir: tempfile::TempDir,
    pub base: String,
}

impl Harness {
    pub async fn new() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::for_dir(dir.path());
        let server = kymo_server::start(cfg).await.unwrap();
        let base = server.base_url();
        Harness { server: Some(server), dir, base }
    }
    pub fn srv(&self) -> &RunningServer {
        self.server.as_ref().unwrap()
    }
    pub fn client(&self) -> Client {
        Client { base: self.base.clone(), http: reqwest::Client::new(), cookie: None, bearer: None, csrf: true }
    }
    pub async fn stop(mut self) {
        if let Some(s) = self.server.take() {
            s.shutdown().await;
        }
    }

    /// Setup admin + enroll a soft passkey; returns a full admin client and its authenticator.
    pub async fn admin(&self) -> (Client, SoftPasskey) {
        let tok = self.srv().setup_token().expect("setup token");
        let mut c = self.client();
        let (st, v) = c
            .post("/api/v1/auth/setup", json!({"setup_token": tok, "username": "admin", "password": ADMIN_PW}))
            .await;
        assert_eq!(st, 200, "{v}");
        assert_eq!(v["state"], "enroll_passkey");
        let mut pk = SoftPasskey::new(true);
        c.enroll(&mut pk, "laptop").await;
        (c, pk)
    }

    /// Admin invites + signs up a regular user (policy off → full session).
    pub async fn user(&self, admin: &mut Client, name: &str) -> Client {
        let (st, inv) = admin.post("/api/v1/admin/invites", json!({"username": name})).await;
        assert_eq!(st, 200, "{inv}");
        let mut c = self.client();
        let (st, v) = c
            .post(
                "/api/v1/auth/signup",
                json!({"invite_token": inv["token"], "username": name, "password": "user password 123"}),
            )
            .await;
        assert_eq!(st, 200, "{v}");
        assert_eq!(v["state"], "full");
        c
    }
}

pub struct Client {
    pub base: String,
    pub http: reqwest::Client,
    pub cookie: Option<String>,
    pub bearer: Option<String>,
    pub csrf: bool,
}

impl Client {
    fn headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(c) = &self.cookie {
            h.insert("cookie", HeaderValue::from_str(&format!("kymo_session={c}")).unwrap());
        }
        if let Some(b) = &self.bearer {
            h.insert("authorization", HeaderValue::from_str(&format!("Bearer {b}")).unwrap());
        }
        if self.csrf {
            h.insert("x-kymo-csrf", HeaderValue::from_static("1"));
        }
        h
    }

    pub async fn send(&mut self, method: reqwest::Method, path: &str, body: Option<Vec<u8>>, extra: HeaderMap) -> (u16, Value) {
        let mut rb = self.http.request(method, format!("{}{}", self.base, path)).headers(self.headers()).headers(extra);
        if let Some(b) = body {
            rb = rb.header("content-type", "application/json").body(b);
        }
        let r = rb.send().await.unwrap();
        let st = r.status().as_u16();
        for sc in r.headers().get_all("set-cookie") {
            let s = sc.to_str().unwrap();
            if let Some(rest) = s.strip_prefix("kymo_session=") {
                let v = rest.split(';').next().unwrap();
                self.cookie = if v.is_empty() { None } else { Some(v.to_string()) };
            }
        }
        let bytes = r.bytes().await.unwrap();
        let v = serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
        (st, v)
    }

    pub async fn get(&mut self, path: &str) -> (u16, Value) {
        self.send(reqwest::Method::GET, path, None, HeaderMap::new()).await
    }
    pub async fn post(&mut self, path: &str, body: Value) -> (u16, Value) {
        self.send(reqwest::Method::POST, path, Some(body.to_string().into_bytes()), HeaderMap::new()).await
    }
    pub async fn patch(&mut self, path: &str, body: Value) -> (u16, Value) {
        self.send(reqwest::Method::PATCH, path, Some(body.to_string().into_bytes()), HeaderMap::new()).await
    }
    pub async fn put(&mut self, path: &str, body: Value) -> (u16, Value) {
        self.send(reqwest::Method::PUT, path, Some(body.to_string().into_bytes()), HeaderMap::new()).await
    }
    pub async fn delete(&mut self, path: &str) -> (u16, Value) {
        self.send(reqwest::Method::DELETE, path, None, HeaderMap::new()).await
    }

    pub async fn enroll(&mut self, pk: &mut SoftPasskey, name: &str) {
        let (st, ccr) = self.post("/api/v1/auth/passkey/register/start", json!({"name": name})).await;
        assert_eq!(st, 200, "{ccr}");
        let ccr: CreationChallengeResponse = serde_json::from_value(ccr).unwrap();
        let cred = pk.do_registration(Url::parse(ORIGIN).unwrap(), ccr).unwrap();
        // browsers add these; the server must tolerate them
        let mut cred = serde_json::to_value(cred).unwrap();
        cred["extensions"] = json!({});
        cred["response"]["transports"] = json!(["internal", "hybrid"]);
        cred["authenticatorAttachment"] = json!("platform");
        let (st, v) = self
            .post("/api/v1/auth/passkey/register/finish", json!({"name": name, "credential": cred}))
            .await;
        assert_eq!(st, 200, "{v}");
    }

    pub async fn passkey_login(&mut self, pk: &mut SoftPasskey) -> (u16, Value) {
        let (st, rcr) = self.post("/api/v1/auth/passkey/login/start", json!({})).await;
        assert_eq!(st, 200, "{rcr}");
        let rcr: RequestChallengeResponse = serde_json::from_value(rcr).unwrap();
        let cred = pk.do_authentication(Url::parse(ORIGIN).unwrap(), rcr).unwrap();
        let mut cred = serde_json::to_value(cred).unwrap();
        cred["extensions"] = json!({});
        cred["authenticatorAttachment"] = json!("platform");
        self.post("/api/v1/auth/passkey/login/finish", json!({"credential": cred})).await
    }

    pub async fn token(&mut self) -> Client {
        let (st, v) = self.post("/api/v1/tokens", json!({"name": "sdk"})).await;
        assert_eq!(st, 200, "{v}");
        Client {
            base: self.base.clone(),
            http: reqwest::Client::new(),
            cookie: None,
            bearer: Some(v["token"].as_str().unwrap().to_string()),
            csrf: false,
        }
    }

    pub async fn ingest(&mut self, body: Value) -> (u16, Value) {
        self.post("/api/v1/ingest", body).await
    }
}
