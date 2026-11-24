use kymo_server::config::Config;
use tracing_subscriber::EnvFilter;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,tower_http=warn")))
        .init();
    let cfg = Config::from_env();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("kymo-io")
        .build()
        .expect("tokio runtime");
    rt.block_on(async move {
        let server = match kymo_server::start(cfg).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("kymo-server failed to start: {e}");
                std::process::exit(1);
            }
        };
        shutdown_signal().await;
        tracing::info!("shutting down: draining requests and writer queues");
        server.shutdown().await;
        tracing::info!("bye");
    });
}
