use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::TenantCtx;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::{audit, llm};

use super::{fetch_draft, DraftRow};

pub(super) struct SaveGenerationInput<'a> {
    pub(super) tenant: Uuid,
    pub(super) id: Uuid,
    pub(super) prev_turns: &'a Value,
    pub(super) user_prompt: &'a str,
    pub(super) generated: &'a llm::GeneratedPlugin,
    pub(super) started: DateTime<Utc>,
}

pub(super) struct AuditGenerationInput<'a> {
    pub(super) ctx: &'a TenantCtx,
    pub(super) draft_id: Uuid,
    pub(super) model: &'a str,
    pub(super) status: &'a str,
    pub(super) error_code: Option<&'a str>,
    pub(super) started: DateTime<Utc>,
}

struct DraftUpdate<'a> {
    files: Value,
    diagnostics: Value,
    status: &'a str,
}

pub(super) async fn audit_generation(st: &AppState, input: AuditGenerationInput<'_>) {
    audit::record(
        st,
        audit::AuditRecord {
            tenant: input.ctx.tenant_id,
            user: input.ctx.user_id,
            kind: "generate",
            plugin_id: None,
            draft_id: Some(input.draft_id),
            capability: None,
            model: Some(input.model),
            status: input.status,
            error_code: input.error_code,
            started: input.started,
        },
    )
    .await;
}

pub(super) async fn save_generation(
    st: &AppState,
    input: SaveGenerationInput<'_>,
) -> AppResult<DraftRow> {
    persist_generation(st, &input).await?;
    fetch_draft(st, input.tenant, input.id).await
}

pub(super) async fn persist_generation(
    st: &AppState,
    input: &SaveGenerationInput<'_>,
) -> AppResult<()> {
    let files = Value::Array(
        input
            .generated
            .files
            .iter()
            .map(|(path, content)| json!({ "path": path, "content": content }))
            .collect(),
    );
    let diagnostics = Value::Array(
        input
            .generated
            .diagnostics
            .iter()
            .map(|(stage, status, message)| {
                json!({ "stage": stage, "status": status, "message": message })
            })
            .collect(),
    );
    let status = if input.generated.ok {
        "ready"
    } else {
        "invalid"
    };
    update_draft(
        st,
        input,
        DraftUpdate {
            files,
            diagnostics,
            status,
        },
    )
    .await
}

async fn update_draft(
    st: &AppState,
    input: &SaveGenerationInput<'_>,
    update: DraftUpdate<'_>,
) -> AppResult<()> {
    let turns = generation_turns(input);
    let affected = sqlx::query(
        "UPDATE plugin_drafts SET files=$1, diagnostics=$2, turns=$3, status=$4, updated_at=CURRENT_TIMESTAMP \
         WHERE id=$5 AND tenant_id=$6",
    )
    .bind(update.files)
    .bind(update.diagnostics)
    .bind(Value::Array(turns))
    .bind(update.status)
    .bind(input.id)
    .bind(input.tenant)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

fn generation_turns(input: &SaveGenerationInput<'_>) -> Vec<Value> {
    let mut turns = input.prev_turns.as_array().cloned().unwrap_or_default();
    turns.push(
        json!({ "role": "user", "content": input.user_prompt, "at": input.started.to_rfc3339() }),
    );
    turns.push(
        json!({ "role": "assistant", "content": input.generated.assistant_note, "at": Utc::now().to_rfc3339() }),
    );
    turns
}
