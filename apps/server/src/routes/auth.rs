//! 身份、租户、成员路由。

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{self, AuthUser, TenantCtx};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct RegisterBody {
    email: String,
    password: String,
    display_name: String,
}

/// 注册凭据校验：邮箱非空且形如 a@b、密码至少 8 位。
/// 防止前端被绕过后写入空账户（见领域约束 docs/02，与 contract 的 zod 规则对齐）。
fn validate_credentials(email: &str, password: &str) -> AppResult<()> {
    let email = email.trim();
    let at = email.find('@');
    let valid_email = match at {
        Some(i) => i > 0 && email[i + 1..].contains('.') && !email.ends_with('.'),
        None => false,
    };
    if !valid_email {
        return Err(AppError::BadRequest("邮箱格式不正确".into()));
    }
    if password.chars().count() < 8 {
        return Err(AppError::BadRequest("密码至少 8 位".into()));
    }
    Ok(())
}

pub async fn register(
    State(st): State<AppState>,
    Json(b): Json<RegisterBody>,
) -> AppResult<Json<Value>> {
    validate_credentials(&b.email, &b.password)?;
    let email = b.email.trim();
    let display_name = if b.display_name.trim().is_empty() {
        email
    } else {
        b.display_name.trim()
    };
    let id = Uuid::new_v4();
    let hash = auth::hash_password(&b.password)?;
    // 单事务：建用户 + 钱包 1000 分初始余额 + 注册赠送流水（三者要么全成要么全不）。
    let mut tx = st.pool.begin().await?;
    // 首个注册用户即平台管理员：在同一事务内以「表中尚无用户」为判据置位，避免并发下出现多个首位。
    let is_first_user = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
        .fetch_one(&mut *tx)
        .await?
        == 0;
    sqlx::query("INSERT INTO users (id, email, display_name, password_hash, is_platform_admin) VALUES ($1,$2,$3,$4,$5)")
        .bind(id)
        .bind(email)
        .bind(display_name)
        .bind(&hash)
        .bind(is_first_user)
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::BadRequest(format!("注册失败（邮箱可能已存在）: {e}")))?;
    sqlx::query("INSERT INTO wallets (user_id, balance_cents) VALUES ($1, 1000)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO wallet_transactions (id, user_id, amount_cents, direction, reason) VALUES ($1, $2, 1000, 'credit', 'signup_bonus')",
    )
    .bind(Uuid::new_v4())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({ "id": id, "email": email, "display_name": display_name, "is_platform_admin": is_first_user }),
    ))
}

#[derive(Deserialize)]
pub struct LoginBody {
    email: String,
    password: String,
}

pub async fn login(State(st): State<AppState>, Json(b): Json<LoginBody>) -> AppResult<Json<Value>> {
    // 空凭据直接拒绝，避免空账户登录。
    if b.email.trim().is_empty() || b.password.is_empty() {
        return Err(AppError::Unauthorized);
    }
    let row = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT id, password_hash, display_name FROM users WHERE email=$1",
    )
    .bind(b.email.trim())
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::Unauthorized)?;
    if !auth::verify_password(&b.password, &row.1) {
        return Err(AppError::Unauthorized);
    }
    let token = auth::issue_token(&st.config.jwt_secret, &row.0.to_string(), None, None)?;
    let is_admin = auth::is_platform_admin(&st, row.0).await;
    Ok(Json(
        json!({ "token": token, "user_id": row.0, "display_name": row.2, "tenant_id": Value::Null, "role": Value::Null, "is_platform_admin": is_admin }),
    ))
}

#[derive(Deserialize)]
pub struct SwitchBody {
    tenant_id: String,
}

pub async fn switch_tenant(
    State(st): State<AppState>,
    user: AuthUser,
    Json(b): Json<SwitchBody>,
) -> AppResult<Json<Value>> {
    let tenant_id =
        Uuid::parse_str(&b.tenant_id).map_err(|_| AppError::BadRequest("tenant_id 非法".into()))?;
    // 一并取出租户名，供前端侧边栏显示「租户名称 + 角色」而非裸 UUID。
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT m.role, t.name FROM memberships m JOIN tenants t ON t.id = m.tenant_id \
         WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active'",
    )
    .bind(tenant_id)
    .bind(user.user_id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::Forbidden)?;
    let (role, tenant_name) = row;
    let token = auth::issue_token(
        &st.config.jwt_secret,
        &user.user_id.to_string(),
        Some(&b.tenant_id),
        Some(&role),
    )?;
    let is_admin = auth::is_platform_admin(&st, user.user_id).await;
    Ok(Json(
        json!({ "token": token, "user_id": user.user_id, "tenant_id": b.tenant_id, "tenant_name": tenant_name, "role": role, "is_platform_admin": is_admin }),
    ))
}

#[derive(Deserialize)]
pub struct CreateTenantBody {
    name: String,
    slug: String,
}

pub async fn create_tenant(
    State(st): State<AppState>,
    user: AuthUser,
    Json(b): Json<CreateTenantBody>,
) -> AppResult<Json<Value>> {
    let id = Uuid::new_v4();
    let mut tx = st.pool.begin().await?;
    sqlx::query("INSERT INTO tenants (id, name, slug, owner_user_id) VALUES ($1,$2,$3,$4)")
        .bind(id)
        .bind(&b.name)
        .bind(&b.slug)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::BadRequest(format!("建租户失败（slug 可能重复）: {e}")))?;
    sqlx::query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')")
        .bind(id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let token = auth::issue_token(
        &st.config.jwt_secret,
        &user.user_id.to_string(),
        Some(&id.to_string()),
        Some("owner"),
    )?;
    Ok(Json(
        json!({ "tenant": { "id": id, "name": b.name, "slug": b.slug }, "tenant_name": b.name, "token": token, "role": "owner" }),
    ))
}

pub async fn my_tenants(State(st): State<AppState>, user: AuthUser) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, String, String, String)>(
        "SELECT t.id, t.name, t.slug, m.role FROM tenants t \
         JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=$1 AND m.status='active'",
    )
    .bind(user.user_id)
    .fetch_all(&st.pool)
    .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, slug, role)| json!({ "id": id, "name": name, "slug": slug, "role": role }))
        .collect();
    Ok(Json(json!({ "tenants": list })))
}

#[derive(Deserialize)]
pub struct InviteBody {
    email: String,
    #[serde(default = "default_role")]
    role: String,
}
fn default_role() -> String {
    "member".to_string()
}

pub async fn invite_member(
    State(st): State<AppState>,
    ctx: TenantCtx,
    Json(b): Json<InviteBody>,
) -> AppResult<Json<Value>> {
    if !ctx.is_admin() {
        return Err(AppError::Forbidden);
    }
    // 角色仅限 admin / member：owner 唯一且通过建租户产生，不经邀请接口设置或转让。
    if b.role != "admin" && b.role != "member" {
        return Err(AppError::BadRequest("角色仅支持 admin 或 member".into()));
    }
    let uid = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email=$1")
        .bind(&b.email)
        .fetch_optional(&st.pool)
        .await?
        .ok_or(AppError::BadRequest("被邀用户尚未注册".into()))?;
    // 不允许改动 owner 成员的角色（防止 owner 被降级）。
    let existing_role = sqlx::query_scalar::<_, String>(
        "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2",
    )
    .bind(ctx.tenant_id)
    .bind(uid)
    .fetch_optional(&st.pool)
    .await?;
    if existing_role.as_deref() == Some("owner") {
        return Err(AppError::BadRequest("不能修改团队所有者的角色".into()));
    }
    sqlx::query(
        "INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1,$2,$3,'active') \
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role=$3, status='active'",
    )
    .bind(ctx.tenant_id)
    .bind(uid)
    .bind(&b.role)
    .execute(&st.pool)
    .await?;
    Ok(Json(
        json!({ "tenant_id": ctx.tenant_id, "user_id": uid, "role": b.role }),
    ))
}

pub async fn list_members(State(st): State<AppState>, ctx: TenantCtx) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, String, String, String)>(
        "SELECT u.id, u.email, u.display_name, m.role FROM memberships m \
         JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1",
    )
    .bind(ctx.tenant_id)
    .fetch_all(&st.pool)
    .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, email, name, role)| json!({ "user_id": id, "email": email, "display_name": name, "role": role }))
        .collect();
    Ok(Json(json!({ "members": list })))
}
