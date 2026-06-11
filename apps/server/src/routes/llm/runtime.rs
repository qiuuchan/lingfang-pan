use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::TenantCtx;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::{audit, llm};

/// 插件运行时 LLM 调用所需的请求体。
#[derive(Deserialize)]
pub struct ProxyBody {
    plugin_id: String,
    messages: Value,
    model: Option<String>,
}

struct UserAllowedInput<'a> {
    tenant: Uuid,
    plugin: &'a str,
    user_id: &'a str,
    role: &'a str,
}

struct RuntimeAuditInput<'a> {
    ctx: &'a TenantCtx,
    plugin_id: &'a str,
    model: Option<&'a str>,
    status: &'a str,
    error_code: Option<&'a str>,
    started: DateTime<Utc>,
}

/// 插件运行时 LLM 调用：校验安装 + 能力 + 授权 → 转发 → 审计。
pub async fn proxy(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(body): Json<ProxyBody>,
) -> AppResult<Json<Value>> {
    let started = Utc::now();
    ensure_installed(&st, ctx.tenant_id, &body.plugin_id).await?;
    ensure_llm_capability(&st, &body.plugin_id).await?;
    ensure_allowed(&st, &ctx, &body.plugin_id, started).await?;

    let binding = llm::resolve_binding(&st, ctx.tenant_id).await?;
    let model = body.model.unwrap_or_else(|| binding.default_model.clone());
    match llm::chat_completion(&st, &binding, &model, body.messages).await {
        Ok(content) => {
            record_runtime(
                &st,
                RuntimeAuditInput {
                    ctx: &ctx,
                    plugin_id: &body.plugin_id,
                    model: Some(&model),
                    status: "ok",
                    error_code: None,
                    started,
                },
            )
            .await;
            Ok(Json(json!({ "content": content })))
        }
        Err(error) => {
            record_runtime(
                &st,
                RuntimeAuditInput {
                    ctx: &ctx,
                    plugin_id: &body.plugin_id,
                    model: Some(&model),
                    status: "error",
                    error_code: Some(error.code()),
                    started,
                },
            )
            .await;
            Err(error)
        }
    }
}

async fn ensure_installed(st: &AppState, tenant: Uuid, plugin_id: &str) -> AppResult<()> {
    let installed = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM plugin_installations WHERE tenant_id=$1 AND plugin_id=$2 AND status='installed'",
    )
    .bind(tenant)
    .bind(plugin_id)
    .fetch_one(&st.pool)
    .await?;
    if installed == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

async fn ensure_llm_capability(st: &AppState, plugin_id: &str) -> AppResult<()> {
    let caps = sqlx::query_scalar::<_, Value>("SELECT capabilities FROM plugins WHERE id=$1")
        .bind(plugin_id)
        .fetch_optional(&st.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    if !has_llm_chat(&caps) {
        return Err(AppError::CapabilityDenied);
    }
    Ok(())
}

fn has_llm_chat(capabilities: &Value) -> bool {
    capabilities
        .as_array()
        .map(|items| {
            items
                .iter()
                .any(|cap| cap.get("kind").and_then(|kind| kind.as_str()) == Some("llm.chat"))
        })
        .unwrap_or(false)
}

async fn ensure_allowed(
    st: &AppState,
    ctx: &TenantCtx,
    plugin_id: &str,
    started: DateTime<Utc>,
) -> AppResult<()> {
    let user_id = ctx.user_id.to_string();
    let allowed = user_allowed(
        st,
        UserAllowedInput {
            tenant: ctx.tenant_id,
            plugin: plugin_id,
            user_id: &user_id,
            role: &ctx.role,
        },
    )
    .await?;
    if allowed {
        return Ok(());
    }
    record_runtime(
        st,
        RuntimeAuditInput {
            ctx,
            plugin_id,
            model: None,
            status: "denied",
            error_code: Some("capability_denied"),
            started,
        },
    )
    .await;
    Err(AppError::CapabilityDenied)
}

async fn record_runtime(st: &AppState, input: RuntimeAuditInput<'_>) {
    audit::record(
        st,
        audit::AuditRecord {
            tenant: input.ctx.tenant_id,
            user: input.ctx.user_id,
            kind: "runtime",
            plugin_id: Some(input.plugin_id),
            draft_id: None,
            capability: Some("llm.chat"),
            model: input.model,
            status: input.status,
            error_code: input.error_code,
            started: input.started,
        },
    )
    .await;
}

/// 授权解析：deny 优先；user 级优先于 role 级；owner/admin 默认可用本租户插件。
async fn user_allowed(st: &AppState, input: UserAllowedInput<'_>) -> AppResult<bool> {
    let grants = sqlx::query_as::<_, (String, String, String)>(
        "SELECT subject_kind,subject_id,effect FROM plugin_grants WHERE tenant_id=$1 AND plugin_id=$2",
    )
    .bind(input.tenant)
    .bind(input.plugin)
    .fetch_all(&st.pool)
    .await?;

    if grant_matches(&grants, "user", input.user_id, "deny") {
        return Ok(false);
    }
    if grant_matches(&grants, "user", input.user_id, "allow") {
        return Ok(true);
    }
    if grant_matches(&grants, "role", input.role, "deny") {
        return Ok(false);
    }
    if grant_matches(&grants, "role", input.role, "allow") {
        return Ok(true);
    }
    Ok(input.role == "owner" || input.role == "admin")
}

fn grant_matches(
    grants: &[(String, String, String)],
    kind: &str,
    subject: &str,
    effect: &str,
) -> bool {
    grants
        .iter()
        .any(|(grant_kind, grant_subject, grant_effect)| {
            grant_kind == kind && grant_subject == subject && grant_effect == effect
        })
}
