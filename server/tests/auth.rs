mod common;
use common::*;
use serde_json::json;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

#[tokio::test]
async fn setup_and_admin_passkey_gate() {
    let h = Harness::new().await;
    let mut c = h.client();
    let (_, st) = c.get("/api/v1/auth/state").await;
    assert_eq!(st["setup_required"], true);
    assert!(st["session_state"].is_null());
    assert!(h.dir.path().join("setup_token").exists());

    let (s, v) = c.post("/api/v1/auth/setup", json!({"setup_token": "nope", "username": "admin", "password": ADMIN_PW})).await;
    assert_eq!(s, 403, "{v}");
    let tok = h.srv().setup_token().unwrap();
    let (s, _) = c.post("/api/v1/auth/setup", json!({"setup_token": tok, "username": "admin", "password": "short"})).await;
    assert_eq!(s, 400);
    let (s, v) = c.post("/api/v1/auth/setup", json!({"setup_token": tok, "username": "admin", "password": ADMIN_PW})).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["state"], "enroll_passkey");
    assert!(!h.dir.path().join("setup_token").exists());

    // enroll_passkey gate: only passkey registration, auth/state and logout
    let (s, v) = c.get("/api/v1/projects").await;
    assert_eq!((s, v["code"].as_str()), (403, Some("session_enroll_passkey")));
    let (s, _) = c.post("/api/v1/tokens", json!({"name": "x"})).await;
    assert_eq!(s, 403);
    let (s, _) = c.get("/api/v1/admin/users").await;
    assert_eq!(s, 403);
    let (s, _) = c.get("/api/v1/auth/passkeys").await;
    assert_eq!(s, 403);
    let (_, st) = c.get("/api/v1/auth/state").await;
    assert_eq!(st["session_state"], "enroll_passkey");
    assert_eq!(st["user"]["is_admin"], true);

    let mut pk = SoftPasskey::new(true);
    c.enroll(&mut pk, "laptop").await;
    let (_, st) = c.get("/api/v1/auth/state").await;
    assert_eq!(st["session_state"], "full");
    assert_eq!(st["setup_required"], false);
    let (s, _) = c.get("/api/v1/admin/users").await;
    assert_eq!(s, 200);

    // setup is gone forever
    let (s, _) = c.post("/api/v1/auth/setup", json!({"setup_token": tok, "username": "admin2", "password": ADMIN_PW})).await;
    assert_eq!(s, 409);

    // cannot delete the last passkey of the admin
    let (_, list) = c.get("/api/v1/auth/passkeys").await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    let id = list[0]["id"].as_i64().unwrap();
    let (s, _) = c.delete(&format!("/api/v1/auth/passkeys/{id}")).await;
    assert_eq!(s, 409);

    // logout + login → passkey_required → passkey login → full
    let (s, _) = c.post("/api/v1/auth/logout", json!({})).await;
    assert_eq!(s, 200);
    let (s, _) = c.get("/api/v1/projects").await;
    assert_eq!(s, 401);
    let (s, v) = c.post("/api/v1/auth/login", json!({"username": "admin", "password": ADMIN_PW})).await;
    assert_eq!(s, 200);
    assert_eq!(v["state"], "passkey_required");
    let (s, v) = c.get("/api/v1/projects").await;
    assert_eq!((s, v["code"].as_str()), (403, Some("session_passkey_required")));
    let (s, _) = c.post("/api/v1/auth/passkey/register/start", json!({"name": "x"})).await;
    assert_eq!(s, 403, "cannot add passkeys before verifying");
    // a different authenticator must fail
    let mut other = SoftPasskey::new(true);
    let (s, rcr) = c.post("/api/v1/auth/passkey/login/start", json!({})).await;
    assert_eq!(s, 200);
    let rcr: webauthn_rs::prelude::RequestChallengeResponse = serde_json::from_value(rcr).unwrap();
    use webauthn_authenticator_rs::WebauthnAuthenticator;
    assert!(other.do_authentication(webauthn_rs::prelude::Url::parse(ORIGIN).unwrap(), rcr).is_err());
    let (s, v) = c.passkey_login(&mut pk).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["state"], "full");
    let (s, _) = c.get("/api/v1/projects").await;
    assert_eq!(s, 200);
    let (_, list) = c.get("/api/v1/auth/passkeys").await;
    assert!(list[0]["last_used_at"].is_string());

    // second passkey → deleting one is fine
    let mut pk2 = SoftPasskey::new(true);
    c.enroll(&mut pk2, "phone").await;
    let (s, _) = c.delete(&format!("/api/v1/auth/passkeys/{id}")).await;
    assert_eq!(s, 200);
    h.stop().await;
}

#[tokio::test]
async fn invites_and_signup() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut anon = h.client();
    let (s, _) = anon.post("/api/v1/auth/signup", json!({"invite_token": "bogus", "username": "bob", "password": "longenough1"})).await;
    assert_eq!(s, 403);

    let (s, inv) = admin.post("/api/v1/admin/invites", json!({"username": "bob", "expires_hours": 1})).await;
    assert_eq!(s, 200, "{inv}");
    let t = inv["token"].as_str().unwrap().to_string();
    assert!(inv["url"].as_str().unwrap().ends_with(&format!("/signup?invite={t}")));
    let (_, info) = anon.get(&format!("/api/v1/auth/invite/{t}")).await;
    assert_eq!(info, json!({"valid": true, "username": "bob"}));
    let (_, info) = anon.get("/api/v1/auth/invite/nope").await;
    assert_eq!(info["valid"], false);

    let (s, v) = anon.post("/api/v1/auth/signup", json!({"invite_token": t, "username": "carol", "password": "longenough1"})).await;
    assert_eq!((s, v["code"].as_str()), (400, Some("username_mismatch")));
    let (s, _) = anon.post("/api/v1/auth/signup", json!({"invite_token": t, "username": "bob", "password": "short"})).await;
    assert_eq!(s, 400);
    let (s, v) = anon.post("/api/v1/auth/signup", json!({"invite_token": t, "username": "bob", "password": "longenough1", "display_name": "Bob"})).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["state"], "full");
    assert_eq!(v["user"]["is_admin"], false);
    let (s, _) = anon.get("/api/v1/projects").await;
    assert_eq!(s, 200);
    // non-admin cannot reach admin endpoints
    let (s, _) = anon.get("/api/v1/admin/users").await;
    assert_eq!(s, 403);
    let (s, _) = anon.post("/api/v1/admin/invites", json!({})).await;
    assert_eq!(s, 403);

    // invite is single use
    let mut other = h.client();
    let (s, _) = other.post("/api/v1/auth/signup", json!({"invite_token": t, "username": "bob", "password": "longenough1"})).await;
    assert_eq!(s, 403);
    let (_, info) = other.get(&format!("/api/v1/auth/invite/{t}")).await;
    assert_eq!(info["valid"], false);

    // open invite (no username), list has no tokens, delete works
    let (_, inv2) = admin.post("/api/v1/admin/invites", json!({})).await;
    let (_, list) = admin.get("/api/v1/admin/invites").await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert!(list[0].get("token").is_none());
    let (s, _) = admin.delete(&format!("/api/v1/admin/invites/{}", inv2["id"])).await;
    assert_eq!(s, 200);
    let (s, _) = other.post("/api/v1/auth/signup", json!({"invite_token": inv2["token"], "username": "dave", "password": "longenough1"})).await;
    assert_eq!(s, 403);

    let (_, users) = admin.get("/api/v1/admin/users").await;
    assert_eq!(users.as_array().unwrap().len(), 2);
    assert_eq!(users[0]["passkey_count"], 1);
    h.stop().await;
}

#[tokio::test]
async fn login_states_policy_and_rate_limit() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut u = h.user(&mut admin, "alice").await;

    let (s, v) = u.post("/api/v1/auth/login", json!({"username": "alice", "password": "wrong password"})).await;
    assert_eq!((s, v["code"].as_str()), (401, Some("invalid_credentials")));
    let (s, v) = u.post("/api/v1/auth/login", json!({"username": "alice", "password": "user password 123"})).await;
    assert_eq!((s, v["state"].as_str()), (200, Some("full")));

    // policy on → existing full session drops to enroll_passkey at next request
    let (s, _) = admin.put("/api/v1/admin/settings", json!({"passkey_required_for_all": true})).await;
    assert_eq!(s, 200);
    let (s, v) = u.get("/api/v1/projects").await;
    assert_eq!((s, v["code"].as_str()), (403, Some("session_enroll_passkey")));
    let (_, st) = u.get("/api/v1/auth/state").await;
    assert_eq!(st["session_state"], "enroll_passkey");
    assert_eq!(st["policy"]["passkey_required_for_all"], true);
    let mut fresh = h.client();
    let (_, v) = fresh.post("/api/v1/auth/login", json!({"username": "alice", "password": "user password 123"})).await;
    assert_eq!(v["state"], "enroll_passkey");
    let mut pk = SoftPasskey::new(true);
    u.enroll(&mut pk, "key").await;
    let (s, _) = u.get("/api/v1/projects").await;
    assert_eq!(s, 200);

    // policy off: a user with a passkey must still use it
    admin.put("/api/v1/admin/settings", json!({"passkey_required_for_all": false})).await;
    let mut c = h.client();
    let (_, v) = c.post("/api/v1/auth/login", json!({"username": "alice", "password": "user password 123"})).await;
    assert_eq!(v["state"], "passkey_required");
    let (s, _) = c.passkey_login(&mut pk).await;
    assert_eq!(s, 200);
    // not the last required passkey any more → may delete
    let (_, list) = c.get("/api/v1/auth/passkeys").await;
    let (s, _) = c.delete(&format!("/api/v1/auth/passkeys/{}", list[0]["id"])).await;
    assert_eq!(s, 200);

    // password change
    let (s, _) = c.post("/api/v1/auth/password", json!({"old_password": "bad", "new_password": "new password 456"})).await;
    assert_eq!(s, 403);
    let (s, _) = c.post("/api/v1/auth/password", json!({"old_password": "user password 123", "new_password": "new password 456"})).await;
    assert_eq!(s, 200);
    let (s, _) = c.get("/api/v1/projects").await;
    assert_eq!(s, 200, "current session survives the password change");
    let (s, _) = u.get("/api/v1/projects").await;
    assert_eq!(s, 401, "other sessions are revoked");

    // admin reset link
    let (_, users) = admin.get("/api/v1/admin/users").await;
    let alice_id = users.as_array().unwrap().iter().find(|u| u["username"] == "alice").unwrap()["id"].clone();
    let (s, r) = admin.post(&format!("/api/v1/admin/users/{alice_id}/reset-password"), json!({})).await;
    assert_eq!(s, 200);
    let mut anon = h.client();
    let (s, _) = anon.post("/api/v1/auth/reset", json!({"reset_token": r["token"], "password": "reset password 789"})).await;
    assert_eq!(s, 200);
    let (s, _) = anon.post("/api/v1/auth/reset", json!({"reset_token": r["token"], "password": "reset password 789"})).await;
    assert_eq!(s, 403, "reset token is single use");
    let (_, v) = anon.post("/api/v1/auth/login", json!({"username": "alice", "password": "reset password 789"})).await;
    assert_eq!(v["state"], "full");

    // disable kills sessions
    let (s, _) = admin.patch(&format!("/api/v1/admin/users/{alice_id}"), json!({"disabled": true})).await;
    assert_eq!(s, 200);
    let (s, _) = anon.get("/api/v1/projects").await;
    assert_eq!(s, 401);
    let (s, v) = anon.post("/api/v1/auth/login", json!({"username": "alice", "password": "reset password 789"})).await;
    assert_eq!((s, v["code"].as_str()), (403, Some("account_disabled")));

    // rate limit: 10 attempts / minute per ip+username
    let mut statuses = vec![];
    for _ in 0..12 {
        let (s, _) = anon.post("/api/v1/auth/login", json!({"username": "nobody", "password": "whatever123"})).await;
        statuses.push(s);
    }
    assert_eq!(statuses.iter().filter(|&&s| s == 401).count(), 10);
    assert_eq!(*statuses.last().unwrap(), 429);
    h.stop().await;
}

#[tokio::test]
async fn token_limits_and_csrf() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut u = h.user(&mut admin, "alice").await;
    let mut t = u.token().await;
    assert!(t.bearer.as_ref().unwrap().starts_with("kymo_"));
    assert_eq!(t.bearer.as_ref().unwrap().len(), 45);

    // ingest + reads allowed
    let (s, v) = t.ingest(json!({"project": "p1", "experiment": "e1", "points": [{"step": 0, "metrics": {"loss": 1.0}}]})).await;
    assert_eq!(s, 200, "{v}");
    let (s, list) = t.get("/api/v1/projects").await;
    assert_eq!(s, 200);
    let pid = list[0]["id"].as_i64().unwrap();
    assert_eq!(t.get(&format!("/api/v1/projects/{pid}/experiments")).await.0, 200);
    let (s, _) = t.post("/api/v1/series/query", json!({"series": [{"experiment_id": v["experiment_id"], "key": "loss"}]})).await;
    assert_eq!(s, 200);
    let (_, st) = t.get("/api/v1/auth/state").await;
    assert_eq!(st["user"]["username"], "alice");

    // never auth / admin / token management / mutations
    for (m, path) in [
        ("POST", "/api/v1/tokens"),
        ("GET", "/api/v1/tokens"),
        ("GET", "/api/v1/admin/users"),
        ("POST", "/api/v1/auth/password"),
        ("GET", "/api/v1/auth/passkeys"),
        ("POST", "/api/v1/auth/passkey/register/start"),
        ("POST", "/api/v1/projects"),
    ] {
        let (s, v) = if m == "GET" { t.get(path).await } else { t.post(path, json!({"name": "x"})).await };
        assert_eq!(s, 403, "{m} {path}: {v}");
        assert_eq!(v["code"], "token_not_allowed", "{m} {path}");
    }
    let (s, _) = t.delete(&format!("/api/v1/projects/{pid}")).await;
    assert_eq!(s, 403);
    let mut bad = h.client();
    bad.bearer = Some("kymo_doesnotexist".into());
    assert_eq!(bad.get("/api/v1/projects").await.0, 401);

    // CSRF: cookie-authenticated mutations need the header
    u.csrf = false;
    let (s, v) = u.post("/api/v1/projects", json!({"name": "x"})).await;
    assert_eq!((s, v["code"].as_str()), (403, Some("csrf")));
    let (s, _) = u.delete(&format!("/api/v1/projects/{pid}")).await;
    assert_eq!(s, 403);
    assert_eq!(u.get("/api/v1/projects").await.0, 200, "GET does not need it");
    u.csrf = true;
    assert_eq!(u.post("/api/v1/projects", json!({"name": "x"})).await.0, 200);

    // revoke → cache invalidated immediately
    let (_, toks) = u.get("/api/v1/tokens").await;
    assert_eq!(toks[0]["prefix"].as_str().unwrap().len(), 9);
    assert!(toks[0].get("token").is_none());
    let (s, _) = u.delete(&format!("/api/v1/tokens/{}", toks[0]["id"])).await;
    assert_eq!(s, 200);
    assert_eq!(t.get("/api/v1/projects").await.0, 401);

    // disabling the owner stops token use
    let mut t2 = u.token().await;
    assert_eq!(t2.get("/api/v1/projects").await.0, 200);
    let (_, users) = admin.get("/api/v1/admin/users").await;
    let id = users.as_array().unwrap().iter().find(|u| u["username"] == "alice").unwrap()["id"].clone();
    admin.patch(&format!("/api/v1/admin/users/{id}"), json!({"disabled": true})).await;
    assert_eq!(t2.get("/api/v1/projects").await.0, 401);
    admin.patch(&format!("/api/v1/admin/users/{id}"), json!({"disabled": false})).await;
    assert_eq!(t2.get("/api/v1/projects").await.0, 200);
    h.stop().await;
}
