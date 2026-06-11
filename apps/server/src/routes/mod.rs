//! 路由组装。租户内资源以 JWT 当前租户（TenantCtx）为准，天然隔离。

mod auth;
mod catalog;
mod drafts;
mod llm;
mod marketplace;
mod wallet;

use crate::state::AppState;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        // 身份
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/switch-tenant", post(auth::switch_tenant))
        // 租户与成员
        .route("/tenants", post(auth::create_tenant))
        .route("/tenants/me", get(auth::my_tenants))
        .route(
            "/members",
            post(auth::invite_member).get(auth::list_members),
        )
        // 插件草稿（产品核心）
        .route("/drafts", post(drafts::create_draft))
        .route("/drafts/:id", get(drafts::get_draft))
        .route("/drafts/:id/generate", post(drafts::generate))
        .route("/drafts/:id/generate/stream", post(drafts::generate_stream))
        .route("/drafts/:id/publish", post(drafts::publish))
        .route("/plugins/:id/edit", post(drafts::edit_from_plugin))
        // 目录 / 安装 / 授权
        .route("/plugins", get(catalog::list_plugins))
        .route("/plugins/:id/files/*file", get(catalog::plugin_file))
        .route("/installations", post(catalog::install))
        .route("/grants", post(catalog::grant).get(catalog::list_grants))
        // M4 市场：搜索 / 详情 / 发布 / 评分 / 安装
        .route("/marketplace/search", get(marketplace::search))
        .route("/marketplace/plugins/:id", get(marketplace::detail))
        .route("/marketplace/publish", post(marketplace::publish_to_market))
        .route("/marketplace/rate", post(marketplace::rate))
        .route(
            "/marketplace/install",
            post(marketplace::install_from_market),
        )
        // M5 平台审核（仅 PlatformAdmin）
        .route("/admin/review/pending", get(marketplace::review_pending))
        .route("/admin/review/approve", post(marketplace::review_approve))
        .route("/admin/review/reject", post(marketplace::review_reject))
        // M5 钱包：余额 + 购买
        .route("/wallet", get(wallet::get_wallet))
        .route("/wallet/purchase", post(wallet::purchase))
        // LLM 绑定 + 运行时代理
        .route(
            "/llm-bindings",
            post(llm::create_binding).get(llm::list_bindings),
        )
        .route("/llm/models", post(llm::fetch_models))
        .route("/llm/test", post(llm::test_model))
        .route("/llm/proxy", post(llm::proxy))
        // 审计
        .route("/audit", get(llm::list_audit))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}
