mod common;
use common::*;
use serde_json::{Value, json};

async fn uid(admin: &mut Client, name: &str) -> i64 {
    let (_, users) = admin.get("/api/v1/admin/users").await;
    users.as_array().unwrap().iter().find(|u| u["username"] == name).unwrap()["id"].as_i64().unwrap()
}

fn find<'a>(list: &'a Value, id: i64) -> Option<&'a Value> {
    list.as_array().unwrap().iter().find(|p| p["id"] == id)
}

#[tokio::test]
async fn sharing_roles() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut alice = h.user(&mut admin, "alice").await;
    let mut bob = h.user(&mut admin, "bob").await;
    let mut carol = h.user(&mut admin, "carol").await;
    let mut dave = h.user(&mut admin, "dave").await;
    let (bob_id, carol_id, alice_id) = (uid(&mut admin, "bob").await, uid(&mut admin, "carol").await, uid(&mut admin, "alice").await);
    let mut ta = alice.token().await;
    let mut tb = bob.token().await;
    let mut tc = carol.token().await;

    let (_, v) = ta.ingest(json!({"project": "proj", "experiment": "e1", "status": "running", "points": [{"step": 0, "metrics": {"m": 1}}]})).await;
    let e1 = v["experiment_id"].as_i64().unwrap();
    let (_, list) = alice.get("/api/v1/projects").await;
    let p = list[0].clone();
    let pid = p["id"].as_i64().unwrap();
    assert_eq!(p["role"], "owner");
    assert_eq!(p["everyone"], Value::Null);
    assert_eq!((p["member_count"].as_i64(), p["running_count"].as_i64(), p["experiment_count"].as_i64()), (Some(0), Some(1), Some(1)));
    assert_eq!(p["owner"]["display_name"], "alice");

    // not shared yet: everybody else gets 404
    assert_eq!(bob.get(&format!("/api/v1/projects/{pid}")).await.0, 404);
    assert_eq!(bob.get(&format!("/api/v1/projects/{pid}/sharing")).await.0, 404);
    assert_eq!(bob.put(&format!("/api/v1/projects/{pid}/sharing"), json!({"everyone": "editor", "members": []})).await.0, 404);

    // validation
    let path = format!("/api/v1/projects/{pid}/sharing");
    assert_eq!(alice.put(&path, json!({"everyone": "owner", "members": []})).await.0, 400);
    assert_eq!(alice.put(&path, json!({"members": [{"user_id": alice_id, "role": "viewer"}]})).await.1["code"], "owner_not_member");
    assert_eq!(alice.put(&path, json!({"members": [{"user_id": 9999, "role": "viewer"}]})).await.1["code"], "unknown_user");
    assert_eq!(alice.put(&path, json!({"members": [{"user_id": bob_id, "role": "admin"}]})).await.0, 400);

    let (s, v) = alice
        .put(&path, json!({"everyone": null, "members": [{"user_id": bob_id, "role": "viewer"}, {"user_id": carol_id, "role": "editor"}]}))
        .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["everyone"], Value::Null);
    assert_eq!(v["members"][0]["user"], json!({"id": bob_id, "username": "bob", "display_name": "bob"}));
    assert_eq!(v["members"][0]["role"], "viewer");
    assert_eq!(v["members"][1]["role"], "editor");
    let (s, g) = bob.get(&path).await;
    assert_eq!((s, &g), (200, &v));
    assert_eq!(find(&alice.get("/api/v1/projects").await.1, pid).unwrap()["member_count"], 2);

    // viewer: read only
    let (_, bl) = bob.get("/api/v1/projects").await;
    assert_eq!(find(&bl, pid).unwrap()["role"], "viewer");
    assert_eq!(bob.get(&format!("/api/v1/experiments/{e1}")).await.1["can_edit"], false);
    assert_eq!(bob.patch(&format!("/api/v1/experiments/{e1}"), json!({"notes": "x"})).await.0, 403);
    assert_eq!(bob.delete(&format!("/api/v1/experiments/{e1}")).await.0, 403);
    assert_eq!(bob.put(&path, json!({"members": []})).await.0, 403);
    let (s, v) = tb.ingest(json!({"project": "alice/proj", "experiment": "b1", "metrics": {"m": 1}})).await;
    assert_eq!((s, v["code"].as_str()), (403, Some("project_forbidden")));
    let (s, v) = tb.post("/api/v1/series/query", json!({"series": [{"experiment_id": e1, "key": "m"}]})).await;
    assert_eq!((s, v["series"][0]["total"].as_i64()), (200, Some(1)));

    // editor: edit/delete experiments, ingest via owner/name; no project management
    let (_, cl) = carol.get("/api/v1/projects").await;
    assert_eq!(find(&cl, pid).unwrap()["role"], "editor");
    assert_eq!(carol.get(&format!("/api/v1/experiments/{e1}")).await.1["can_edit"], true);
    assert_eq!(carol.patch(&format!("/api/v1/experiments/{e1}"), json!({"notes": "by carol"})).await.0, 200);
    let (s, v) = tc.ingest(json!({"project": "alice/proj", "experiment": "c1", "points": [{"step": 0, "metrics": {"m": 2}}]})).await;
    assert_eq!(s, 200, "{v}");
    let c1 = v["experiment_id"].as_i64().unwrap();
    assert_eq!(alice.get(&format!("/api/v1/experiments/{c1}")).await.1["project"]["id"], pid, "lands in alice's project");
    assert!(carol.get("/api/v1/projects").await.1.as_array().unwrap().iter().all(|p| p["owner"]["username"] == "alice"),
        "no project auto-created in carol's namespace");
    let (s, _) = tc.ingest(json!({"project": "alice/missing", "experiment": "x", "metrics": {"m": 1}})).await;
    assert_eq!(s, 403, "other users' projects are never auto-created");
    assert_eq!(carol.patch(&format!("/api/v1/projects/{pid}"), json!({"name": "renamed"})).await.0, 403);
    assert_eq!(carol.patch(&format!("/api/v1/projects/{pid}"), json!({"description": "d"})).await.0, 403);
    assert_eq!(carol.delete(&format!("/api/v1/projects/{pid}")).await.0, 403);
    assert_eq!(carol.put(&path, json!({"members": []})).await.0, 403);
    assert_eq!(carol.delete(&format!("/api/v1/experiments/{c1}")).await.0, 200);
    // the owner can use owner/name for their own project too
    assert_eq!(ta.ingest(json!({"project": "alice/proj", "experiment": "e1", "metrics": {"m": 3}})).await.0, 200);

    // non-member
    assert_eq!(dave.get(&format!("/api/v1/projects/{pid}")).await.0, 404);
    assert!(find(&dave.get("/api/v1/projects").await.1, pid).is_none());
    assert_eq!(dave.get(&format!("/api/v1/experiments/{e1}")).await.0, 404);

    // everyone=viewer covers users created later; explicit higher member role wins
    alice.put(&path, json!({"everyone": "viewer", "members": [{"user_id": carol_id, "role": "editor"}]})).await;
    let mut eve = h.user(&mut admin, "eve").await;
    assert_eq!(find(&eve.get("/api/v1/projects").await.1, pid).unwrap()["role"], "viewer");
    assert_eq!(eve.patch(&format!("/api/v1/experiments/{e1}"), json!({"notes": "x"})).await.0, 403);
    assert_eq!(find(&dave.get("/api/v1/projects").await.1, pid).unwrap()["role"], "viewer");
    assert_eq!(find(&carol.get("/api/v1/projects").await.1, pid).unwrap()["role"], "editor");
    let (_, p) = bob.get(&format!("/api/v1/projects/{pid}")).await;
    assert_eq!((p["role"].as_str(), p["everyone"].as_str(), p["shared"].as_bool()), (Some("viewer"), Some("viewer"), Some(true)));
    // everyone=editor beats an explicit viewer membership (higher role wins)
    alice.put(&path, json!({"everyone": "editor", "members": [{"user_id": bob_id, "role": "viewer"}]})).await;
    assert_eq!(bob.get(&format!("/api/v1/projects/{pid}")).await.1["role"], "editor");
    assert_eq!(tb.ingest(json!({"project": "alice/proj", "experiment": "b1", "metrics": {"m": 1}})).await.0, 200);

    // revoking takes effect immediately, also for ingest (resolution cache invalidated)
    assert_eq!(tc.ingest(json!({"project": "alice/proj", "experiment": "c2", "metrics": {"m": 1}})).await.0, 200);
    alice.put(&path, json!({"everyone": null, "members": []})).await;
    assert_eq!(tc.ingest(json!({"project": "alice/proj", "experiment": "c2", "metrics": {"m": 1}})).await.0, 403);
    assert_eq!(carol.get(&format!("/api/v1/projects/{pid}")).await.0, 404);
    assert_eq!(tb.get(&format!("/api/v1/projects/{pid}")).await.0, 404);

    // admin sees everything with role admin and may manage sharing
    let (_, al) = admin.get("/api/v1/projects").await;
    assert_eq!(find(&al, pid).unwrap()["role"], "admin");
    assert_eq!(admin.put(&path, json!({"everyone": "viewer"})).await.0, 200);
    h.stop().await;
}

#[tokio::test]
async fn users_directory() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut alice = h.user(&mut admin, "alice").await;
    h.user(&mut admin, "bob").await;
    let mut t = alice.token().await;
    let (s, v) = t.get("/api/v1/users").await;
    assert_eq!((s, v["code"].as_str()), (403, Some("token_not_allowed")));
    let (s, v) = alice.get("/api/v1/users").await;
    assert_eq!(s, 200);
    let names: Vec<_> = v.as_array().unwrap().iter().map(|u| u["username"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["admin", "alice", "bob"]);
    assert_eq!(v[1].as_object().unwrap().len(), 3, "only id, username, display_name: {}", v[1]);
    let bob = uid(&mut admin, "bob").await;
    admin.patch(&format!("/api/v1/admin/users/{bob}"), json!({"disabled": true})).await;
    assert_eq!(alice.get("/api/v1/users").await.1.as_array().unwrap().len(), 2, "disabled users are hidden");
    assert_eq!(h.client().get("/api/v1/users").await.0, 401);
    h.stop().await;
}

#[tokio::test]
async fn migration_shared_to_everyone() {
    let dir = tempfile::tempdir().unwrap();
    {
        // a v1 data dir as written by the previous server version
        let mut c = rusqlite::Connection::open(dir.path().join("meta.sqlite")).unwrap();
        kymo_server::db::migrate(&mut c, &kymo_server::db::META_MIGRATIONS[..1]).unwrap();
        c.execute_batch(
            "INSERT INTO users(id, username, display_name, password_hash, webauthn_id, created_at) VALUES
               (1, 'alice', 'Alice', '!', x'00', 0), (2, 'bob', 'Bob', '!', x'00', 0);
             INSERT INTO projects(id, owner_id, name, shared, created_at) VALUES (1, 1, 'pub', 1, 0), (2, 1, 'priv', 0, 0);",
        )
        .unwrap();
        let h = kymo_server::util::sha256(b"kymo_bobtoken");
        c.execute(
            "INSERT INTO api_tokens(user_id, name, token_hash, prefix, created_at) VALUES(2, 't', ?1, 'kymo_bobt', 0)",
            [&h[..]],
        )
        .unwrap();
    }
    let s = kymo_server::start(kymo_server::config::Config::for_dir(dir.path())).await.unwrap();
    assert!(!s.setup_required());
    let mut bob = Client { base: s.base_url(), http: reqwest::Client::new(), cookie: None, bearer: Some("kymo_bobtoken".into()), csrf: false };
    let (st, list) = bob.get("/api/v1/projects").await;
    assert_eq!(st, 200, "{list}");
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["name"], "pub");
    assert_eq!(list[0]["everyone"], "viewer");
    assert_eq!(list[0]["role"], "viewer");
    assert_eq!(bob.get("/api/v1/projects/2").await.0, 404);
    s.shutdown().await;
    let c = rusqlite::Connection::open(dir.path().join("meta.sqlite")).unwrap();
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v as usize, kymo_server::db::META_MIGRATIONS.len());
    // restarting an already migrated dir is a no-op
    let s = kymo_server::start(kymo_server::config::Config::for_dir(dir.path())).await.unwrap();
    s.shutdown().await;
}
