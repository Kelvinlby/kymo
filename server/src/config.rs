use std::path::PathBuf;

/// Runtime configuration, read from the environment (see SPEC §6).
#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub data_dir: PathBuf,
    pub rp_id: String,
    /// Allowed origins; the first one is canonical (used for links).
    pub origins: Vec<String>,
    pub web_dir: PathBuf,
    pub shards: usize,
    pub cache_mb: usize,
    /// Trust `X-Forwarded-For` for the client IP (rate limiting). Off by default.
    pub trust_proxy: bool,
    /// Print the setup token to stdout (tests switch this off).
    pub print_setup_token: bool,
}

impl Config {
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let origins: Vec<String> = env("KYMO_ORIGIN")
            .unwrap_or_else(|| "http://localhost:8080".into())
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Config {
            bind: env("KYMO_BIND").unwrap_or_else(|| "0.0.0.0:8080".into()),
            data_dir: env("KYMO_DATA_DIR").unwrap_or_else(|| "./data".into()).into(),
            rp_id: env("KYMO_RP_ID").unwrap_or_else(|| "localhost".into()),
            origins,
            web_dir: env("KYMO_WEB_DIR").unwrap_or_else(|| "../web/dist".into()).into(),
            shards: env("KYMO_SHARDS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(cores.min(16))
                .clamp(1, 256),
            cache_mb: env("KYMO_CACHE_MB").and_then(|v| v.parse().ok()).unwrap_or(2048),
            trust_proxy: env("KYMO_TRUST_PROXY").is_some_and(|v| v == "1" || v == "true"),
            print_setup_token: true,
        }
    }

    /// A config suitable for tests / the in-process benchmark.
    pub fn for_dir(dir: impl Into<PathBuf>) -> Self {
        Config {
            bind: "127.0.0.1:0".into(),
            data_dir: dir.into(),
            rp_id: "localhost".into(),
            origins: vec!["http://localhost:8080".into(), "http://localhost:5173".into()],
            web_dir: "/nonexistent-kymo-web".into(),
            shards: 4,
            cache_mb: 512,
            trust_proxy: false,
            print_setup_token: false,
        }
    }

    pub fn canonical_origin(&self) -> &str {
        self.origins.first().map(|s| s.as_str()).unwrap_or("http://localhost:8080")
    }

    pub fn secure_cookies(&self) -> bool {
        self.canonical_origin().starts_with("https://")
    }
}
