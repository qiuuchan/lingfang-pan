//! 插件目录 / 安装 / 授权路由。

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

use crate::auth::TenantCtx;
use crate::error::{AppError, AppResult};
use crate::plugin_policy::{install_policy, InstallPolicyInput};
use crate::state::AppState;

/// 列出本租户「我的插件」：本租户发布的（author_tenant）+ 从市场安装的（installations），去重合并。
/// 返回 entry/runtime_type/source，供壳运行数据库插件（source=published|installed）。
pub async fn list_plugins(State(st): State<AppState>, ctx: TenantCtx) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, (String, String, String, String, Value, String, bool)>(
        "SELECT p.id, p.name, p.version, p.description, p.capabilities, p.entry, \
                (p.author_tenant_id = $1) AS authored \
         FROM plugins p \
         WHERE p.status='listed' AND ( \
                 p.author_tenant_id = $1 \
              OR EXISTS (SELECT 1 FROM plugin_installations i \
                         WHERE i.plugin_id = p.id AND i.tenant_id = $1 AND i.status='installed') \
         ) \
         ORDER BY p.created_at DESC",
    )
    .bind(ctx.tenant_id)
    .fetch_all(&st.pool)
    .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, version, desc, caps, entry, authored)| {
            json!({
                "id": id, "name": name, "version": version, "description": desc,
                "capabilities": caps, "entry": entry,
                "source": if authored { "published" } else { "installed" },
            })
        })
        .collect();
    Ok(Json(json!({ "plugins": list })))
}

/// 读取数据库插件的某个文件内容（供壳运行已发布/已安装插件）。
/// 仅限本租户可见：本租户发布的或已安装的插件。
pub async fn plugin_file(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Path((id, file)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    let files = sqlx::query_scalar::<_, Value>(
        "SELECT p.files FROM plugins p \
         WHERE p.id=$1 AND p.status='listed' AND ( \
                 p.author_tenant_id = $2 \
              OR EXISTS (SELECT 1 FROM plugin_installations i \
                         WHERE i.plugin_id = p.id AND i.tenant_id = $2 AND i.status='installed') \
         )",
    )
    .bind(&id)
    .bind(ctx.tenant_id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::NotFound)?;

    let content = files
        .as_array()
        .and_then(|arr| {
            arr.iter()
                .find(|f| f.get("path").and_then(|p| p.as_str()) == Some(file.as_str()))
                .and_then(|f| f.get("content"))
                .and_then(|c| c.as_str())
        })
        .ok_or(AppError::NotFound)?;
    Ok(Json(json!({ "path": file, "content": content })))
}

#[derive(Deserialize)]
pub struct InstallBody {
    plugin_id: String,
}

pub async fn install(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(b): Json<InstallBody>,
) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, (String, Uuid, bool, String, i32)>(
        "SELECT version, author_tenant_id, marketplace, review_status, price_cents \
         FROM plugins WHERE id=$1 AND status='listed'",
    )
    .bind(&b.plugin_id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    let (version, author_tenant, marketplace, review_status, price_cents) = row;
    let purchased = if price_cents > 0 {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM purchases WHERE plugin_id=$1 AND buyer_user_id=$2",
        )
        .bind(&b.plugin_id)
        .bind(ctx.user_id)
        .fetch_one(&st.pool)
        .await?
            > 0
    } else {
        false
    };
    let input = InstallPolicyInput::new(ctx.tenant_id, author_tenant, &review_status)
        .marketplace(marketplace)
        .price_cents(price_cents)
        .purchased(purchased);
    install_policy(input)?;
    sqlx::query(
        "INSERT INTO plugin_installations (tenant_id,plugin_id,version,installed_by) VALUES ($1,$2,$3,$4) \
         ON CONFLICT (tenant_id,plugin_id) DO UPDATE SET version=$3, status='installed'",
    )
    .bind(ctx.tenant_id)
    .bind(&b.plugin_id)
    .bind(&version)
    .bind(ctx.user_id)
    .execute(&st.pool)
    .await?;
    Ok(Json(
        json!({ "tenant_id": ctx.tenant_id, "plugin_id": b.plugin_id, "version": version, "status": "installed" }),
    ))
}

#[derive(Deserialize)]
pub struct GrantBody {
    plugin_id: String,
    subject_kind: String, // 'user' | 'role'
    subject_id: String,
    effect: String, // 'allow' | 'deny'
}

pub async fn grant(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(b): Json<GrantBody>,
) -> AppResult<Json<Value>> {
    if !ctx.is_admin() {
        return Err(AppError::Forbidden);
    }
    sqlx::query(
        "INSERT INTO plugin_grants (id,tenant_id,plugin_id,subject_kind,subject_id,effect) VALUES ($1,$2,$3,$4,$5,$6)",
    )
    .bind(Uuid::new_v4())
    .bind(ctx.tenant_id)
    .bind(&b.plugin_id)
    .bind(&b.subject_kind)
    .bind(&b.subject_id)
    .bind(&b.effect)
    .execute(&st.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn list_grants(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let rows = match q.get("plugin_id") {
        Some(pid) => {
            sqlx::query_as::<_, (String, String, String, String)>(
                "SELECT plugin_id,subject_kind,subject_id,effect FROM plugin_grants WHERE tenant_id=$1 AND plugin_id=$2",
            )
            .bind(ctx.tenant_id)
            .bind(pid)
            .fetch_all(&st.pool)
            .await?
        }
        None => {
            sqlx::query_as::<_, (String, String, String, String)>(
                "SELECT plugin_id,subject_kind,subject_id,effect FROM plugin_grants WHERE tenant_id=$1",
            )
            .bind(ctx.tenant_id)
            .fetch_all(&st.pool)
            .await?
        }
    };
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(p, k, s, e)| json!({ "plugin_id": p, "subject_kind": k, "subject_id": s, "effect": e }))
        .collect();
    Ok(Json(json!({ "grants": list })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_policy_rejects_private_cross_tenant_plugin() {
        let current = Uuid::new_v4();
        let author = Uuid::new_v4();

        let input = InstallPolicyInput::new(current, author, "pending");
        let err = install_policy(input).unwrap_err();

        assert_eq!(err.code(), "not_found");
    }

    #[test]
    fn install_policy_requires_purchase_for_paid_marketplace_plugin() {
        let current = Uuid::new_v4();
        let author = Uuid::new_v4();

        let input = InstallPolicyInput::new(current, author, "approved")
            .marketplace(true)
            .price_cents(500);
        let err = install_policy(input).unwrap_err();

        assert_eq!(err.code(), "payment_required");
    }
}
