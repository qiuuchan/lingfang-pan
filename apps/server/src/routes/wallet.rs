//! M5 钱包路由：余额查询 + 购买结算（内部账本，不接真实支付）。
//!
//! 金额一律以「分」(cents) 计。购买采用单事务结算：
//! 买家条件扣款（余额不足则 0 行→失败）→ 卖家加款 → 写购买记录 + 双向流水。
//! 并发安全：条件扣款 `balance>=price` + purchases UNIQUE(plugin_id,buyer_user_id) 双重防重复扣费。

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{AuthUser, TenantCtx};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 查询当前用户钱包：余额 + 最近 100 条流水。
pub async fn get_wallet(State(st): State<AppState>, user: AuthUser) -> AppResult<Json<Value>> {
    // 钱包行在注册时创建；存量用户由迁移回填。缺失则视为 0（不自动建行，避免读操作写库）。
    let balance =
        sqlx::query_scalar::<_, i64>("SELECT balance_cents FROM wallets WHERE user_id=$1")
            .bind(user.user_id)
            .fetch_optional(&st.pool)
            .await?
            .unwrap_or(0);

    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            i64,
            String,
            String,
            Option<String>,
            chrono::DateTime<chrono::Utc>,
        ),
    >(
        "SELECT id, amount_cents, direction, reason, plugin_id, created_at \
         FROM wallet_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
    )
    .bind(user.user_id)
    .fetch_all(&st.pool)
    .await?;

    let transactions: Vec<Value> = rows
        .into_iter()
        .map(|(id, amount, direction, reason, plugin_id, at)| {
            json!({
                "id": id, "amount_cents": amount, "direction": direction,
                "reason": reason, "plugin_id": plugin_id, "at": at.to_rfc3339()
            })
        })
        .collect();

    Ok(Json(
        json!({ "balance_cents": balance, "transactions": transactions }),
    ))
}

#[derive(Deserialize)]
pub struct PurchaseBody {
    plugin_id: String,
}

/// 购买插件：单事务结算。买家扣款、卖家同额加款，写购买记录与双向流水。
/// 幂等：已购买直接返回 already_purchased，不重复扣费。
pub async fn purchase(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(b): Json<PurchaseBody>,
) -> AppResult<Json<Value>> {
    // 取插件价格与卖家（作者）。必须是已审核通过的市场插件。
    let plugin = sqlx::query_as::<_, (i32, Option<Uuid>)>(
        "SELECT price_cents, author_user_id FROM plugins \
         WHERE id=$1 AND marketplace=true AND status='listed' AND review_status='approved'",
    )
    .bind(&b.plugin_id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    let (price_cents, seller) = plugin;

    if price_cents <= 0 {
        return Err(AppError::BadRequest("免费插件无需购买，可直接安装".into()));
    }
    let seller = seller.ok_or_else(|| AppError::BadRequest("插件无作者信息，无法结算".into()))?;
    if seller == ctx.user_id {
        return Err(AppError::BadRequest("不能购买自己的插件".into()));
    }

    // 幂等：已购买直接返回，不重复扣费。
    let already = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM purchases WHERE plugin_id=$1 AND buyer_user_id=$2",
    )
    .bind(&b.plugin_id)
    .bind(ctx.user_id)
    .fetch_one(&st.pool)
    .await?;
    if already > 0 {
        let balance =
            sqlx::query_scalar::<_, i64>("SELECT balance_cents FROM wallets WHERE user_id=$1")
                .bind(ctx.user_id)
                .fetch_optional(&st.pool)
                .await?
                .unwrap_or(0);
        return Ok(Json(
            json!({ "status": "already_purchased", "balance_cents": balance }),
        ));
    }

    let price = price_cents as i64;
    let mut tx = st.pool.begin().await?;

    // 条件扣款：余额不足则 0 行受影响 → InsufficientBalance（避免余额变负）。
    let debited = sqlx::query(
        "UPDATE wallets SET balance_cents = balance_cents - $2, updated_at = CURRENT_TIMESTAMP \
         WHERE user_id=$1 AND balance_cents >= $2",
    )
    .bind(ctx.user_id)
    .bind(price)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if debited == 0 {
        // 事务回滚（drop tx 即回滚）。
        return Err(AppError::InsufficientBalance);
    }

    // 卖家加款（卖家钱包行理论上存在；稳妥用 upsert 兜底）。
    sqlx::query(
        "INSERT INTO wallets (user_id, balance_cents) VALUES ($1, $2) \
         ON CONFLICT (user_id) DO UPDATE SET balance_cents = wallets.balance_cents + $2, updated_at = CURRENT_TIMESTAMP",
    )
    .bind(seller)
    .bind(price)
    .execute(&mut *tx)
    .await?;

    // 购买记录（UNIQUE 防并发重复购买；若并发已插入则失败回滚）。主键由应用层生成。
    sqlx::query(
        "INSERT INTO purchases (id, plugin_id, buyer_user_id, buyer_tenant_id, seller_user_id, price_cents) \
         VALUES ($1,$2,$3,$4,$5,$6)",
    )
    .bind(Uuid::new_v4())
    .bind(&b.plugin_id)
    .bind(ctx.user_id)
    .bind(ctx.tenant_id)
    .bind(seller)
    .bind(price_cents)
    .execute(&mut *tx)
    .await
    .map_err(|_| AppError::BadRequest("购买冲突，请重试".into()))?;

    // 双向流水：买家 debit、卖家 credit。主键由应用层生成。
    sqlx::query(
        "INSERT INTO wallet_transactions (id, user_id, amount_cents, direction, reason, plugin_id, counterparty_user_id) \
         VALUES ($1,$2,$3,'debit','purchase',$4,$5)",
    )
    .bind(Uuid::new_v4())
    .bind(ctx.user_id)
    .bind(price)
    .bind(&b.plugin_id)
    .bind(seller)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO wallet_transactions (id, user_id, amount_cents, direction, reason, plugin_id, counterparty_user_id) \
         VALUES ($1,$2,$3,'credit','sale',$4,$5)",
    )
    .bind(Uuid::new_v4())
    .bind(seller)
    .bind(price)
    .bind(&b.plugin_id)
    .bind(ctx.user_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let balance =
        sqlx::query_scalar::<_, i64>("SELECT balance_cents FROM wallets WHERE user_id=$1")
            .bind(ctx.user_id)
            .fetch_one(&st.pool)
            .await?;
    Ok(Json(
        json!({ "status": "purchased", "plugin_id": b.plugin_id, "price_cents": price_cents, "balance_cents": balance }),
    ))
}
