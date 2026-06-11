//! M4/M5 市场路由：搜索 / 发布到市场 / 评分 / 详情 / 审核。
//!
//! 市场是跨租户的：插件作者可把已发布插件挂到市场（marketplace=true），
//! 经平台审核员审核通过（review_status='approved'）后，其他租户可搜索、查看、购买、安装。
//! 付费插件需先购买（内部钱包结算，见 wallet.rs）；免费插件直接安装。

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::auth::{PlatformAdmin, TenantCtx};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 搜索市场插件：?q=关键词&sort=installs|rating|recent
/// 仅返回已审核通过（approved）的上架插件。
pub async fn search(
    State(st): State<AppState>,
    _ctx: TenantCtx,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let keyword = q.get("q").cloned().unwrap_or_default();
    let sort = q.get("sort").map(|s| s.as_str()).unwrap_or("installs");
    let order = match sort {
        "rating" => "avg_score DESC NULLS LAST",
        "recent" => "p.created_at DESC",
        _ => "p.install_count DESC",
    };

    // 关键词匹配 name/description（LIKE 对 ASCII 大小写不敏感）。
    let pattern = format!("%{}%", keyword);
    let sql = format!(
        "SELECT p.id, p.name, p.version, p.description, p.install_count, p.price_cents, \
                CAST(COALESCE(AVG(r.score), 0) AS REAL) AS avg_score, COUNT(r.score) AS rating_count \
         FROM plugins p \
         LEFT JOIN plugin_ratings r ON r.plugin_id = p.id \
         WHERE p.marketplace = 1 AND p.status = 'listed' AND p.review_status = 'approved' \
           AND (p.name LIKE $1 OR p.description LIKE $1) \
         GROUP BY p.id \
         ORDER BY {order} LIMIT 50"
    );
    let rows = sqlx::query_as::<_, (String, String, String, String, i32, i32, f64, i64)>(&sql)
        .bind(&pattern)
        .fetch_all(&st.pool)
        .await?;

    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, version, desc, installs, price, avg, count)| {
            json!({
                "id": id, "name": name, "version": version, "description": desc,
                "install_count": installs, "price_cents": price, "is_free": price == 0,
                "avg_score": (avg * 10.0).round() / 10.0, "rating_count": count
            })
        })
        .collect();
    Ok(Json(json!({ "plugins": list })))
}

/// 市场插件详情：含平均分、评论、价格，以及当前用户是否已购买。
pub async fn detail(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Path(plugin_id): Path<String>,
) -> AppResult<Json<Value>> {
    let p = sqlx::query_as::<_, (String, String, String, String, i32, i32, Value)>(
        "SELECT id, name, version, description, install_count, price_cents, capabilities FROM plugins \
         WHERE id=$1 AND marketplace=1 AND status='listed' AND review_status='approved'",
    )
    .bind(&plugin_id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::NotFound)?;

    let ratings = sqlx::query_as::<_, (i16, String, chrono::DateTime<chrono::Utc>)>(
        "SELECT score, comment, created_at FROM plugin_ratings WHERE plugin_id=$1 ORDER BY created_at DESC LIMIT 50",
    )
    .bind(&plugin_id)
    .fetch_all(&st.pool)
    .await?;

    let avg = sqlx::query_scalar::<_, Option<f64>>(
        "SELECT CAST(AVG(score) AS REAL) FROM plugin_ratings WHERE plugin_id=$1",
    )
    .bind(&plugin_id)
    .fetch_one(&st.pool)
    .await?
    .unwrap_or(0.0);

    let price_cents = p.5;
    // 已购买：付费插件据此决定前端显示「购买」还是「安装」。免费插件视为已可安装。
    let purchased = if price_cents == 0 {
        true
    } else {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM purchases WHERE plugin_id=$1 AND buyer_user_id=$2",
        )
        .bind(&plugin_id)
        .bind(ctx.user_id)
        .fetch_one(&st.pool)
        .await?
            > 0
    };

    // 已安装到本租户：免费插件评分以此为门槛。
    let installed = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM plugin_installations WHERE plugin_id=$1 AND tenant_id=$2 AND status='installed'",
    )
    .bind(&plugin_id)
    .bind(ctx.tenant_id)
    .fetch_one(&st.pool)
    .await?
        > 0;
    // 可评分：付费看是否购买，免费看是否安装（与 rate 端点的前置条件一致）。
    let can_rate = if price_cents > 0 {
        purchased
    } else {
        installed
    };

    let reviews: Vec<Value> = ratings
        .into_iter()
        .map(|(score, comment, at)| json!({ "score": score, "comment": comment, "at": at.to_rfc3339() }))
        .collect();

    Ok(Json(json!({
        "id": p.0, "name": p.1, "version": p.2, "description": p.3,
        "install_count": p.4, "price_cents": price_cents, "is_free": price_cents == 0,
        "purchased": purchased, "installed": installed, "can_rate": can_rate, "capabilities": p.6,
        "avg_score": (avg * 10.0).round() / 10.0, "reviews": reviews
    })))
}

#[derive(Deserialize)]
pub struct PublishMarketBody {
    plugin_id: String,
    /// 价格（分）；0 或缺省为免费。
    #[serde(default)]
    price_cents: i32,
}

/// 把本租户已发布的插件挂到市场（仅作者租户的 admin），并提交审核。
/// 已审核通过的插件再次提交（改价）不强制重审，保持 approved。
pub async fn publish_to_market(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(b): Json<PublishMarketBody>,
) -> AppResult<Json<Value>> {
    if !ctx.is_admin() {
        return Err(AppError::Forbidden);
    }
    if b.price_cents < 0 {
        return Err(AppError::BadRequest("价格不能为负".into()));
    }
    // 仅作者租户可操作；未审核过的置 pending，已 approved 的保持（仅改价不重审）。
    let affected = sqlx::query(
        "UPDATE plugins SET marketplace=1, price_cents=$3, \
                review_status = CASE WHEN review_status='approved' THEN 'approved' ELSE 'pending' END \
         WHERE id=$1 AND author_tenant_id=$2",
    )
    .bind(&b.plugin_id)
    .bind(ctx.tenant_id)
    .bind(b.price_cents)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound);
    }
    let review_status =
        sqlx::query_scalar::<_, String>("SELECT review_status FROM plugins WHERE id=$1")
            .bind(&b.plugin_id)
            .fetch_one(&st.pool)
            .await?;
    Ok(Json(
        json!({ "plugin_id": b.plugin_id, "marketplace": true, "price_cents": b.price_cents, "review_status": review_status }),
    ))
}

#[derive(Deserialize)]
pub struct RateBody {
    plugin_id: String,
    score: i16,
    #[serde(default)]
    comment: String,
}

/// 评分：1-5 分，一个用户对一个插件唯一（重复评分则更新）。
/// 前置条件：付费插件须当前用户已购买；免费插件须已安装到本租户——未消费不得评分。
pub async fn rate(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(b): Json<RateBody>,
) -> AppResult<Json<Value>> {
    if !(1..=5).contains(&b.score) {
        return Err(AppError::BadRequest("评分须为 1-5".into()));
    }
    // 必须是市场插件，并取价格用于判定消费方式。
    let price_cents = sqlx::query_scalar::<_, i32>(
        "SELECT price_cents FROM plugins WHERE id=$1 AND marketplace=1",
    )
    .bind(&b.plugin_id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::NotFound)?;

    // 消费校验：付费看 purchases；免费看本租户是否已安装。
    let consumed = if price_cents > 0 {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM purchases WHERE plugin_id=$1 AND buyer_user_id=$2",
        )
        .bind(&b.plugin_id)
        .bind(ctx.user_id)
        .fetch_one(&st.pool)
        .await?
    } else {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM plugin_installations WHERE plugin_id=$1 AND tenant_id=$2 AND status='installed'",
        )
        .bind(&b.plugin_id)
        .bind(ctx.tenant_id)
        .fetch_one(&st.pool)
        .await?
    };
    if consumed == 0 {
        return Err(AppError::BadRequest(
            if price_cents > 0 {
                "请先购买该插件后再评分"
            } else {
                "请先安装该插件后再评分"
            }
            .into(),
        ));
    }

    sqlx::query(
        "INSERT INTO plugin_ratings (plugin_id,user_id,tenant_id,score,comment) VALUES ($1,$2,$3,$4,$5) \
         ON CONFLICT (plugin_id,user_id) DO UPDATE SET score=$4, comment=$5, created_at=CURRENT_TIMESTAMP",
    )
    .bind(&b.plugin_id)
    .bind(ctx.user_id)
    .bind(ctx.tenant_id)
    .bind(b.score)
    .bind(&b.comment)
    .execute(&st.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

/// 从市场安装到本租户（复用 installations 逻辑 + 递增 install_count）。
/// 付费插件须先由当前用户购买（见 wallet.rs），否则 PaymentRequired；免费插件直接安装。
#[derive(Deserialize)]
pub struct InstallMarketBody {
    plugin_id: String,
}

pub async fn install_from_market(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(b): Json<InstallMarketBody>,
) -> AppResult<Json<Value>> {
    let row = sqlx::query_as::<_, (String, i32)>(
        "SELECT version, price_cents FROM plugins \
         WHERE id=$1 AND marketplace=1 AND status='listed' AND review_status='approved'",
    )
    .bind(&b.plugin_id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    let (version, price_cents) = row;

    // 付费插件：校验当前用户已购买。
    if price_cents > 0 {
        let bought = sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM purchases WHERE plugin_id=$1 AND buyer_user_id=$2",
        )
        .bind(&b.plugin_id)
        .bind(ctx.user_id)
        .fetch_one(&st.pool)
        .await?;
        if bought == 0 {
            return Err(AppError::PaymentRequired);
        }
    }

    let mut tx = st.pool.begin().await?;
    sqlx::query(
        "INSERT INTO plugin_installations (tenant_id,plugin_id,version,installed_by) VALUES ($1,$2,$3,$4) \
         ON CONFLICT (tenant_id,plugin_id) DO UPDATE SET version=$3, status='installed'",
    )
    .bind(ctx.tenant_id)
    .bind(&b.plugin_id)
    .bind(&version)
    .bind(ctx.user_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE plugins SET install_count = install_count + 1 WHERE id=$1")
        .bind(&b.plugin_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(
        json!({ "plugin_id": b.plugin_id, "version": version, "status": "installed" }),
    ))
}

// ---------- 平台审核（仅 PlatformAdmin）----------

/// 待审核插件列表：已挂市场但 review_status='pending'。
pub async fn review_pending(
    State(st): State<AppState>,
    _admin: PlatformAdmin,
) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            i32,
            chrono::DateTime<chrono::Utc>,
        ),
    >(
        "SELECT id, name, version, description, price_cents, created_at FROM plugins \
         WHERE marketplace=1 AND review_status='pending' ORDER BY created_at ASC",
    )
    .fetch_all(&st.pool)
    .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, version, desc, price, at)| {
            json!({
                "id": id, "name": name, "version": version, "description": desc,
                "price_cents": price, "is_free": price == 0, "at": at.to_rfc3339()
            })
        })
        .collect();
    Ok(Json(json!({ "plugins": list })))
}

#[derive(Deserialize)]
pub struct ReviewActionBody {
    plugin_id: String,
    #[serde(default)]
    reason: String,
}

/// 审核通过。
pub async fn review_approve(
    State(st): State<AppState>,
    _admin: PlatformAdmin,
    Json(b): Json<ReviewActionBody>,
) -> AppResult<Json<Value>> {
    let affected = sqlx::query(
        "UPDATE plugins SET review_status='approved', review_reason='' WHERE id=$1 AND marketplace=1",
    )
    .bind(&b.plugin_id)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(
        json!({ "plugin_id": b.plugin_id, "review_status": "approved" }),
    ))
}

/// 审核驳回（附理由）。
pub async fn review_reject(
    State(st): State<AppState>,
    _admin: PlatformAdmin,
    Json(b): Json<ReviewActionBody>,
) -> AppResult<Json<Value>> {
    let affected = sqlx::query(
        "UPDATE plugins SET review_status='rejected', review_reason=$2 WHERE id=$1 AND marketplace=1",
    )
    .bind(&b.plugin_id)
    .bind(&b.reason)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(
        json!({ "plugin_id": b.plugin_id, "review_status": "rejected", "review_reason": b.reason }),
    ))
}
