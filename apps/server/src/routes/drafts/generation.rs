use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::TenantCtx;
use crate::error::{AppError, AppResult};
use crate::llm;
use crate::state::AppState;

use super::{draft_json, fetch_draft, DraftRow};
use persist::{audit_generation, save_generation, AuditGenerationInput, SaveGenerationInput};

mod persist;

#[derive(Deserialize)]
pub struct GenBody {
    prompt: String,
    model: Option<String>,
}

pub async fn generate(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Path(id): Path<Uuid>,
    Json(b): Json<GenBody>,
) -> AppResult<Json<Value>> {
    let started = Utc::now();
    let row = fetch_draft(&st, ctx.tenant_id, id).await?;
    let binding = llm::resolve_binding(&st, ctx.tenant_id).await?;
    let model = b
        .model
        .clone()
        .unwrap_or_else(|| binding.default_model.clone());

    match llm::generate_plugin(&st, &binding, &model, &b.prompt, &row.files).await {
        Ok(g) => {
            save_generation(
                &st,
                SaveGenerationInput {
                    tenant: ctx.tenant_id,
                    id,
                    prev_turns: &row.turns,
                    user_prompt: &b.prompt,
                    generated: &g,
                    started,
                },
            )
            .await?;
            audit_generation(
                &st,
                AuditGenerationInput {
                    ctx: &ctx,
                    draft_id: id,
                    model: &model,
                    status: "ok",
                    error_code: None,
                    started,
                },
            )
            .await;
            let updated = fetch_draft(&st, ctx.tenant_id, id).await?;
            Ok(Json(draft_json(&updated)))
        }
        Err(e) => {
            audit_generation(
                &st,
                AuditGenerationInput {
                    ctx: &ctx,
                    draft_id: id,
                    model: &model,
                    status: "error",
                    error_code: Some(e.code()),
                    started,
                },
            )
            .await;
            Err(e)
        }
    }
}

pub async fn generate_stream(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Path(id): Path<Uuid>,
    Json(b): Json<GenBody>,
) -> AppResult<
    axum::response::Sse<
        impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
    >,
> {
    use axum::response::sse::Sse;
    use tokio::sync::mpsc;
    use tokio_stream::wrappers::UnboundedReceiverStream;

    let started = Utc::now();
    let row = fetch_draft(&st, ctx.tenant_id, id).await?;
    let binding = llm::resolve_binding(&st, ctx.tenant_id).await?;
    let model = b
        .model
        .clone()
        .unwrap_or_else(|| binding.default_model.clone());
    let (tx, rx) = mpsc::unbounded_channel();

    tokio::spawn(run_stream(StreamRun {
        st,
        ctx,
        id,
        row,
        prompt: b.prompt,
        binding,
        model,
        started,
        tx,
    }));

    Ok(Sse::new(UnboundedReceiverStream::new(rx)))
}

struct StreamRun {
    st: AppState,
    ctx: TenantCtx,
    id: Uuid,
    row: DraftRow,
    prompt: String,
    binding: llm::ResolvedBinding,
    model: String,
    started: DateTime<Utc>,
    tx: tokio::sync::mpsc::UnboundedSender<
        Result<axum::response::sse::Event, std::convert::Infallible>,
    >,
}

async fn run_stream(run: StreamRun) {
    let _ = send_event(&run.tx, "stage", "已连接模型，开始生成…".to_string());
    let messages = llm::build_messages(&run.prompt, &run.row.files);
    let result = stream_llm(&run, messages).await;
    match result.and_then(|raw| llm::finalize_generation(&raw)) {
        Ok(g) => send_saved_or_error(&run, &g).await,
        Err(e) => send_generation_error(&run, e).await,
    }
}

async fn stream_llm(run: &StreamRun, messages: Value) -> Result<String, AppError> {
    let token_tx = run.tx.clone();
    let mut last_stage = String::new();
    llm::chat_completion_stream(
        &run.st,
        &run.binding,
        &run.model,
        messages,
        |delta| match delta {
            llm::StreamDelta::Reasoning(r) => {
                let _ = send_event(&token_tx, "reasoning", r.replace('\r', ""));
            }
            llm::StreamDelta::Content { token, full } => {
                let _ = send_event(&token_tx, "token", token.replace('\r', ""));
                let stage = llm::stream_stage(full);
                if stage != last_stage {
                    last_stage = stage.clone();
                    let _ = send_event(&token_tx, "stage", stage);
                }
            }
        },
    )
    .await
}

async fn send_saved_or_error(run: &StreamRun, g: &llm::GeneratedPlugin) {
    match save_generation(
        &run.st,
        SaveGenerationInput {
            tenant: run.ctx.tenant_id,
            id: run.id,
            prev_turns: &run.row.turns,
            user_prompt: &run.prompt,
            generated: g,
            started: run.started,
        },
    )
    .await
    {
        Ok(updated) => {
            audit_generation(
                &run.st,
                AuditGenerationInput {
                    ctx: &run.ctx,
                    draft_id: run.id,
                    model: &run.model,
                    status: "ok",
                    error_code: None,
                    started: run.started,
                },
            )
            .await;
            let _ = send_event(&run.tx, "done", draft_json(&updated).to_string());
        }
        Err(e) => send_generation_error(run, e).await,
    }
}

async fn send_generation_error(run: &StreamRun, e: AppError) {
    audit_generation(
        &run.st,
        AuditGenerationInput {
            ctx: &run.ctx,
            draft_id: run.id,
            model: &run.model,
            status: "error",
            error_code: Some(e.code()),
            started: run.started,
        },
    )
    .await;
    let payload = json!({ "error": e.code(), "message": e.to_string() }).to_string();
    let _ = send_event(&run.tx, "error", payload);
}

fn send_event(
    tx: &tokio::sync::mpsc::UnboundedSender<
        Result<axum::response::sse::Event, std::convert::Infallible>,
    >,
    name: &str,
    data: String,
) -> Result<
    (),
    tokio::sync::mpsc::error::SendError<
        Result<axum::response::sse::Event, std::convert::Infallible>,
    >,
> {
    tx.send(Ok(axum::response::sse::Event::default()
        .event(name)
        .data(data)))
}

#[cfg(test)]
mod tests;
