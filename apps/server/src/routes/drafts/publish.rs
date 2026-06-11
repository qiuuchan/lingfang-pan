use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::TenantCtx;
use crate::error::{AppError, AppResult};
use crate::plugin_policy::{publish_policy, PublishDecision};
use crate::state::AppState;

use super::fetch_draft;

pub async fn publish(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let row = fetch_draft(&st, ctx.tenant_id, id).await?;
    if row.status != "ready" {
        return Err(AppError::BadRequest("草稿未通过校验，不能发布".into()));
    }
    let manifest = parse_manifest(&row.files)?;
    let existing = existing_plugin(&st, &manifest.id).await?;
    let existing_author = existing.as_ref().map(|(author, _)| *author);
    let is_marketplace = existing
        .as_ref()
        .map(|(_, marketplace)| *marketplace)
        .unwrap_or(false);
    let decision = publish_policy(existing_author, ctx.tenant_id, is_marketplace)?;

    persist_published_plugin(
        &st,
        PublishedPluginInput {
            manifest: &manifest,
            tenant_id: ctx.tenant_id,
            user_id: ctx.user_id,
            files: &row.files,
            decision,
        },
    )
    .await?;

    mark_published(&st, id, ctx.tenant_id).await?;
    Ok(Json(json!({
        "plugin_id": manifest.id,
        "name": manifest.name,
        "version": manifest.version
    })))
}

struct PublishManifest {
    id: String,
    name: String,
    version: String,
    description: String,
    runtime: String,
    entry: String,
    visibility: String,
    capabilities: Value,
}

fn parse_manifest(files: &Value) -> AppResult<PublishManifest> {
    let list = files.as_array().cloned().unwrap_or_default();
    let manifest_str = list
        .iter()
        .find(|f| f.get("path").and_then(|p| p.as_str()) == Some("manifest.json"))
        .and_then(|f| f.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| AppError::GenerationInvalid("缺少 manifest.json".into()))?;
    let m: Value = serde_json::from_str(manifest_str)
        .map_err(|e| AppError::GenerationInvalid(e.to_string()))?;
    let id = m
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::GenerationInvalid("manifest 缺 id".into()))?;
    Ok(PublishManifest {
        id: id.to_string(),
        name: m
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(id)
            .to_string(),
        version: m
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("0.1.0")
            .to_string(),
        description: m
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        runtime: m
            .get("runtime_type")
            .and_then(|v| v.as_str())
            .unwrap_or("client")
            .to_string(),
        entry: m
            .get("entry")
            .and_then(|v| v.as_str())
            .unwrap_or("ui/index.html")
            .to_string(),
        visibility: m
            .get("visibility")
            .and_then(|v| v.as_str())
            .unwrap_or("tenant")
            .to_string(),
        capabilities: m.get("capabilities").cloned().unwrap_or_else(|| json!([])),
    })
}

async fn existing_plugin(st: &AppState, id: &str) -> AppResult<Option<(Uuid, bool)>> {
    sqlx::query_as::<_, (Uuid, bool)>(
        "SELECT author_tenant_id, marketplace FROM plugins WHERE id=$1",
    )
    .bind(id)
    .fetch_optional(&st.pool)
    .await
    .map_err(AppError::from)
}

struct PublishedPluginInput<'a> {
    manifest: &'a PublishManifest,
    tenant_id: Uuid,
    user_id: Uuid,
    files: &'a Value,
    decision: PublishDecision,
}

async fn persist_published_plugin(st: &AppState, input: PublishedPluginInput<'_>) -> AppResult<()> {
    if let Some(review_status) = input.decision.review_status {
        update_existing_plugin(st, &input, review_status).await
    } else {
        upsert_plugin(st, &input).await
    }
}

async fn update_existing_plugin(
    st: &AppState,
    input: &PublishedPluginInput<'_>,
    review_status: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE plugins SET name=$2, version=$3, description=$4, author_user_id=$5, \
         runtime_type=$6, entry=$7, capabilities=$8, visibility=$9, files=$10, review_status=$11 \
         WHERE id=$1 AND author_tenant_id=$12",
    )
    .bind(&input.manifest.id)
    .bind(&input.manifest.name)
    .bind(&input.manifest.version)
    .bind(&input.manifest.description)
    .bind(input.user_id)
    .bind(&input.manifest.runtime)
    .bind(&input.manifest.entry)
    .bind(&input.manifest.capabilities)
    .bind(&input.manifest.visibility)
    .bind(input.files)
    .bind(review_status)
    .bind(input.tenant_id)
    .execute(&st.pool)
    .await?;
    Ok(())
}

async fn upsert_plugin(st: &AppState, input: &PublishedPluginInput<'_>) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO plugins (id,name,version,description,author_tenant_id,author_user_id,runtime_type,entry,capabilities,visibility,files) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) \
         ON CONFLICT (id) DO UPDATE SET name=$2, version=$3, description=$4, author_user_id=$6, \
             runtime_type=$7, entry=$8, capabilities=$9, visibility=$10, files=$11",
    )
    .bind(&input.manifest.id)
    .bind(&input.manifest.name)
    .bind(&input.manifest.version)
    .bind(&input.manifest.description)
    .bind(input.tenant_id)
    .bind(input.user_id)
    .bind(&input.manifest.runtime)
    .bind(&input.manifest.entry)
    .bind(&input.manifest.capabilities)
    .bind(&input.manifest.visibility)
    .bind(input.files)
    .execute(&st.pool)
    .await?;
    Ok(())
}

async fn mark_published(st: &AppState, id: Uuid, tenant_id: Uuid) -> AppResult<()> {
    sqlx::query("UPDATE plugin_drafts SET status='published', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND tenant_id=$2")
        .bind(id)
        .bind(tenant_id)
        .execute(&st.pool)
        .await?;
    Ok(())
}
