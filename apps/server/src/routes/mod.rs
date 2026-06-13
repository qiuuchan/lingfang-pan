//! 路由组装。租户内资源以 JWT 当前租户（TenantCtx）为准，天然隔离。
//!
//! 注：LLM 生成 / 钱包 / 市场已迁移至 collab-api（NestJS，/api/* 前缀），
//! 本服务仅保留身份、租户、插件草稿 CRUD 与目录安装的旧契约骨架。

mod auth;
mod catalog;
mod drafts;

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
        // 插件草稿 CRUD（生成能力已下线，改由 desktop 本地 code_assistant 完成）
        .route("/drafts", post(drafts::create_draft))
        .route("/drafts/:id", get(drafts::get_draft))
        .route("/drafts/:id/publish", post(drafts::publish))
        .route("/plugins/:id/edit", post(drafts::edit_from_plugin))
        // 目录 / 安装 / 授权
        .route("/plugins", get(catalog::list_plugins))
        .route("/plugins/:id/files/*file", get(catalog::plugin_file))
        .route("/installations", post(catalog::install))
        .route("/grants", post(catalog::grant).get(catalog::list_grants))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}