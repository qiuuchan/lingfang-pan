//! 插件草稿路由（产品核心）：create / get / generate / publish。

mod generation;
mod publish;

pub use generation::{generate, generate_stream};
pub use publish::publish;

use axum::{
    extract::{Path, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::TenantCtx;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(sqlx::FromRow)]
pub(super) struct DraftRow {
    id: Uuid,
    tenant_id: Uuid,
    created_by: Uuid,
    title: String,
    source_prompt: String,
    status: String,
    files: Value,
    turns: Value,
    diagnostics: Value,
    updated_at: DateTime<Utc>,
}

fn draft_json(r: &DraftRow) -> Value {
    json!({
        "id": r.id,
        "tenant_id": r.tenant_id,
        "created_by": r.created_by,
        "title": r.title,
        "source_prompt": r.source_prompt,
        "status": r.status,
        "files": r.files,
        "turns": r.turns,
        "diagnostics": r.diagnostics,
        "updated_at": r.updated_at.to_rfc3339(),
    })
}

pub(super) async fn fetch_draft(st: &AppState, tenant: Uuid, id: Uuid) -> AppResult<DraftRow> {
    sqlx::query_as::<_, DraftRow>(
        "SELECT id,tenant_id,created_by,title,source_prompt,status,files,turns,diagnostics,updated_at \
         FROM plugin_drafts WHERE id=$1 AND tenant_id=$2",
    )
    .bind(id)
    .bind(tenant)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
pub struct CreateBody {
    title: Option<String>,
    prompt: String,
}

pub async fn create_draft(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(b): Json<CreateBody>,
) -> AppResult<Json<Value>> {
    let id = Uuid::new_v4();
    let title = b.title.unwrap_or_default();
    let turns = json!([{ "role": "user", "content": b.prompt, "at": Utc::now().to_rfc3339() }]);
    sqlx::query(
        "INSERT INTO plugin_drafts (id,tenant_id,created_by,title,source_prompt,status,turns) \
         VALUES ($1,$2,$3,$4,$5,'generating',$6)",
    )
    .bind(id)
    .bind(ctx.tenant_id)
    .bind(ctx.user_id)
    .bind(&title)
    .bind(&b.prompt)
    .bind(turns)
    .execute(&st.pool)
    .await?;
    let row = fetch_draft(&st, ctx.tenant_id, id).await?;
    Ok(Json(draft_json(&row)))
}

pub async fn get_draft(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let row = fetch_draft(&st, ctx.tenant_id, id).await?;
    Ok(Json(draft_json(&row)))
}

/// 从已发布插件创建一个可迭代草稿（载回对话页继续修改）。
/// 仅作者租户可操作；复制插件现有 files 作为草稿初始内容，状态直接为 ready 便于预览与继续迭代。
pub async fn edit_from_plugin(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Path(plugin_id): Path<String>,
) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, (String, String, Value)>(
        "SELECT name, description, files FROM plugins \
         WHERE id=$1 AND author_tenant_id=$2 AND status='listed'",
    )
    .bind(&plugin_id)
    .bind(ctx.tenant_id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    let (name, description, files) = row;

    // files 可能为空（历史发布未存内容）——此时不允许迭代，提示重新生成。
    let has_files = files.as_array().map(|a| !a.is_empty()).unwrap_or(false);
    if !has_files {
        return Err(AppError::BadRequest(
            "该插件没有可编辑的源码（可能是旧版本发布），请重新生成".into(),
        ));
    }

    let id = Uuid::new_v4();
    let prompt = format!("继续完善已发布插件「{name}」：{description}");
    let turns = json!([{ "role": "assistant", "content": format!("已载入插件「{name}」，告诉我你想怎么修改。"), "at": Utc::now().to_rfc3339() }]);
    sqlx::query(
        "INSERT INTO plugin_drafts (id,tenant_id,created_by,title,source_prompt,status,files,turns) \
         VALUES ($1,$2,$3,$4,$5,'ready',$6,$7)",
    )
    .bind(id)
    .bind(ctx.tenant_id)
    .bind(ctx.user_id)
    .bind(&name)
    .bind(&prompt)
    .bind(&files)
    .bind(turns)
    .execute(&st.pool)
    .await?;
    let row = fetch_draft(&st, ctx.tenant_id, id).await?;
    Ok(Json(draft_json(&row)))
}
