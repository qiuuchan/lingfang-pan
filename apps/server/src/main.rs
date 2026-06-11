//! LingFang 多租户服务端入口（Rust + axum，见 ADR-0003）。
//! 红线：未配置 DATABASE_URL 直接退出——无内存/文件 demo 兜底。

mod audit;
mod auth;
mod config;
mod crypto;
mod db;
mod error;
mod llm;
mod plugin_policy;
mod routes;
mod state;

use axum::http::{header, HeaderValue, Method};
use config::Config;
use state::AppState;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

fn cors_layer(config: &Config) -> CorsLayer {
    if config.cors_allowed_origins.is_empty() {
        return CorsLayer::permissive();
    }

    let origins = config
        .cors_allowed_origins
        .iter()
        .map(|origin| {
            origin
                .parse::<HeaderValue>()
                .unwrap_or_else(|_| panic!("CORS_ALLOWED_ORIGINS 包含无效来源: {origin}"))
        })
        .collect::<Vec<_>>();

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

#[tokio::main]
async fn main() {
    // 从仓库根或当前目录加载 .env（一键启动脚本依赖此项，无需手动导出环境变量）。
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_path("../../.env");

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env();
    config.validate().expect("运行配置无效");
    let pool = db::connect_and_migrate(&config.database_url).await;
    // 迁移完成后标记平台审核员（幂等）。
    if let Some(email) = &config.platform_admin_email {
        db::seed_platform_admin(&pool, email).await;
    }
    let bind_addr = config.bind_addr.clone();
    let cors = cors_layer(&config);
    let state = AppState {
        pool,
        config,
        http: reqwest::Client::new(),
    };

    let app = routes::router()
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("绑定端口失败");
    tracing::info!("lingfang-server 监听 http://{bind_addr}");
    axum::serve(listener, app).await.expect("服务异常退出");
}
