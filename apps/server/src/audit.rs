//! 调用审计写入（generate / runtime 两类，见 docs/02）。只记事实，不记费用。

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::state::AppState;

pub struct AuditRecord<'a> {
    pub tenant: Uuid,
    pub user: Uuid,
    pub kind: &'a str,
    pub plugin_id: Option<&'a str>,
    pub draft_id: Option<Uuid>,
    pub capability: Option<&'a str>,
    pub model: Option<&'a str>,
    pub status: &'a str,
    pub error_code: Option<&'a str>,
    pub started: DateTime<Utc>,
}

pub async fn record(st: &AppState, input: AuditRecord<'_>) {
    // 审计失败不应影响主流程，故忽略错误。
    let _ = sqlx::query(
        "INSERT INTO invocation_audits \
         (id,tenant_id,kind,plugin_id,draft_id,user_id,capability,model,status,error_code,started_at,finished_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)",
    )
    .bind(Uuid::new_v4())
    .bind(input.tenant)
    .bind(input.kind)
    .bind(input.plugin_id)
    .bind(input.draft_id)
    .bind(input.user)
    .bind(input.capability)
    .bind(input.model)
    .bind(input.status)
    .bind(input.error_code)
    .bind(input.started)
    .execute(&st.pool)
    .await;
}
