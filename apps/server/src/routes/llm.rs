//! LLM 网关绑定管理 + 运行时代理 + 审计查询。

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::TenantCtx;
use crate::crypto;
use crate::error::{AppError, AppResult};
use crate::llm;
use crate::state::AppState;

mod runtime;
pub use runtime::proxy;

#[derive(Deserialize)]
pub struct BindingBody {
    name: String,
    base_url: String,
    /// 留空表示沿用已保存的 key（仅切换模型/改名时无需重填密钥）。
    #[serde(default)]
    api_key: String,
    models: Vec<String>,
}

pub async fn create_binding(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(b): Json<BindingBody>,
) -> AppResult<Json<Value>> {
    if !ctx.is_admin() {
        return Err(AppError::Forbidden);
    }
    // key 留空：复用本租户已存绑定的密文（切换模型场景无需重填）；无旧绑定则必须提供。
    let cipher = if b.api_key.trim().is_empty() {
        sqlx::query_scalar::<_, String>(
            "SELECT api_key_ciphertext FROM llm_gateway_bindings WHERE tenant_id=$1 ORDER BY created_at LIMIT 1",
        )
        .bind(ctx.tenant_id)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| AppError::BadRequest("尚未保存过 API Key，请先填入".into()))?
    } else {
        crypto::encrypt(&b.api_key, &st.config.key_encryption_secret)
    };
    let id = Uuid::new_v4();
    let models = json!(b.models);
    // 网关地址由 app 配置固定，每租户单一绑定：先清掉旧绑定，再写入（保存即更新 key/模型）。
    sqlx::query("DELETE FROM llm_gateway_bindings WHERE tenant_id=$1")
        .bind(ctx.tenant_id)
        .execute(&st.pool)
        .await?;
    sqlx::query(
        "INSERT INTO llm_gateway_bindings (id,tenant_id,name,base_url,api_key_ciphertext,models,created_by) \
         VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(id)
    .bind(ctx.tenant_id)
    .bind(&b.name)
    .bind(&b.base_url)
    .bind(&cipher)
    .bind(models)
    .bind(ctx.user_id)
    .execute(&st.pool)
    .await?;
    Ok(Json(json!({
        "id": id, "name": b.name, "base_url": b.base_url,
        "api_key_masked": crypto::mask_cipher(&cipher, &st.config.key_encryption_secret), "models": b.models
    })))
}

pub async fn list_bindings(State(st): State<AppState>, ctx: TenantCtx) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, String, String, String, Value, String)>(
        "SELECT id,name,base_url,api_key_ciphertext,models,status FROM llm_gateway_bindings WHERE tenant_id=$1",
    )
    .bind(ctx.tenant_id)
    .fetch_all(&st.pool)
    .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, base, cipher, models, status)| {
            let masked = crypto::decrypt(&cipher, &st.config.key_encryption_secret)
                .map(|k| crypto::mask(&k))
                .unwrap_or_else(|| "****".into());
            json!({ "id": id, "name": name, "base_url": base, "api_key_masked": masked, "models": models, "status": status })
        })
        .collect();
    Ok(Json(json!({ "bindings": list })))
}

/// 网关连接凭据：base_url 来自客户端打包配置、api_key 为用户输入。
/// 二者缺省（已保存过绑定的情况）则回退用本租户已存绑定，便于"测试/获取"复用已配置的 key。
#[derive(Deserialize)]
pub struct ModelsBody {
    base_url: Option<String>,
    api_key: Option<String>,
}

async fn resolve_creds(
    st: &AppState,
    ctx: &TenantCtx,
    base_url: Option<String>,
    api_key: Option<String>,
) -> AppResult<(String, String)> {
    match api_key.filter(|k| !k.is_empty()) {
        Some(key) => Ok((base_url.unwrap_or_default(), key)),
        None => {
            let bd = llm::resolve_binding(st, ctx.tenant_id).await?;
            Ok((bd.base_url, bd.api_key))
        }
    }
}

/// 拉取网关可用模型列表（兼连接/key 校验）。仅 owner/admin。
pub async fn fetch_models(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(b): Json<ModelsBody>,
) -> AppResult<Json<Value>> {
    if !ctx.is_admin() {
        return Err(AppError::Forbidden);
    }
    let (base_url, api_key) = resolve_creds(&st, &ctx, b.base_url, b.api_key).await?;
    let models = llm::list_models(&st, &base_url, &api_key).await?;
    Ok(Json(json!({ "models": models })))
}

#[derive(Deserialize)]
pub struct TestBody {
    base_url: Option<String>,
    api_key: Option<String>,
    model: String,
}

/// 测试指定模型：发一条最小对话，确认模型可用。仅 owner/admin。
pub async fn test_model(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(b): Json<TestBody>,
) -> AppResult<Json<Value>> {
    if !ctx.is_admin() {
        return Err(AppError::Forbidden);
    }
    let (base_url, api_key) = resolve_creds(&st, &ctx, b.base_url, b.api_key).await?;
    let binding = llm::ResolvedBinding {
        base_url,
        api_key,
        default_model: b.model.clone(),
    };
    let reply = llm::chat_completion(
        &st,
        &binding,
        &b.model,
        json!([{ "role": "user", "content": "ping" }]),
    )
    .await?;
    let sample: String = reply.chars().take(80).collect();
    Ok(Json(json!({ "ok": true, "sample": sample })))
}

pub async fn list_audit(State(st): State<AppState>, ctx: TenantCtx) -> AppResult<Json<Value>> {
    if !ctx.is_admin() {
        return Err(AppError::Forbidden);
    }
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            Option<String>,
            Option<Uuid>,
            Uuid,
            Option<String>,
            String,
            Option<String>,
        ),
    >(
        "SELECT id,kind,plugin_id,draft_id,user_id,model,status,error_code FROM invocation_audits \
         WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 200",
    )
    .bind(ctx.tenant_id)
    .fetch_all(&st.pool)
    .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, kind, pid, did, uid, model, status, err)| {
            json!({ "id": id, "kind": kind, "plugin_id": pid, "draft_id": did, "user_id": uid, "model": model, "status": status, "error_code": err })
        })
        .collect();
    Ok(Json(json!({ "audits": list })))
}
