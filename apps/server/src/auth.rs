//! 鉴权：密码哈希（argon2）、JWT 签发/校验、请求上下文提取器。
//! 租户隔离的基石：TenantCtx 强制要求 JWT 已选定 tenant_id。

use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // user_id
    pub tenant_id: Option<String>,
    pub role: Option<String>,
    pub exp: usize,
}

pub fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(e.to_string()))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .ok()
        .map(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

pub fn issue_token(
    secret: &str,
    user_id: &str,
    tenant_id: Option<&str>,
    role: Option<&str>,
) -> Result<String, AppError> {
    let exp = (Utc::now() + Duration::days(7)).timestamp() as usize;
    let claims = Claims {
        sub: user_id.to_string(),
        tenant_id: tenant_id.map(|s| s.to_string()),
        role: role.map(|s| s.to_string()),
        exp,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(e.to_string()))
}

fn extract_claims(parts: &Parts, state: &AppState) -> Result<Claims, AppError> {
    let header = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    let token = header
        .strip_prefix("Bearer ")
        .ok_or(AppError::Unauthorized)?;
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| AppError::Unauthorized)?;
    Ok(data.claims)
}

/// 已登录用户（租户可能尚未选定）。
#[allow(dead_code)] // tenant_id / role 由 JWT 携带，供后续按需读取
pub struct AuthUser {
    pub user_id: Uuid,
    pub tenant_id: Option<Uuid>,
    pub role: Option<String>,
}

/// 已选定租户的上下文——所有租户内资源路由都用它，强制隔离。
pub struct TenantCtx {
    pub user_id: Uuid,
    pub tenant_id: Uuid,
    pub role: String,
}

impl TenantCtx {
    pub fn is_admin(&self) -> bool {
        self.role == "owner" || self.role == "admin"
    }
}

/// 平台审核员上下文：JWT 合法 + DB 标记 is_platform_admin，否则 Forbidden。
/// 与租户角色正交——审核员是平台级身份，跨所有租户。
#[allow(dead_code)] // user_id 供审计/扩展按需读取，当前审核端点以存在性为准
pub struct PlatformAdmin {
    pub user_id: Uuid,
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let claims = extract_claims(parts, state)?;
        Ok(AuthUser {
            user_id: Uuid::parse_str(&claims.sub).map_err(|_| AppError::Unauthorized)?,
            tenant_id: claims.tenant_id.and_then(|s| Uuid::parse_str(&s).ok()),
            role: claims.role,
        })
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for TenantCtx {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let claims = extract_claims(parts, state)?;
        let tenant_id = claims
            .tenant_id
            .and_then(|s| Uuid::parse_str(&s).ok())
            .ok_or(AppError::Forbidden)?;
        let user_id = Uuid::parse_str(&claims.sub).map_err(|_| AppError::Unauthorized)?;
        let role = sqlx::query_scalar::<_, String>(
            "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
        )
        .bind(tenant_id)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::Forbidden)?;
        Ok(TenantCtx {
            user_id,
            tenant_id,
            role,
        })
    }
}

/// 查用户是否为平台审核员（供 login/switch_tenant 在响应里回传，前端据此显示「审核」入口）。
pub async fn is_platform_admin(state: &AppState, user_id: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT is_platform_admin FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

#[axum::async_trait]
impl FromRequestParts<AppState> for PlatformAdmin {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let claims = extract_claims(parts, state)?;
        let user_id = Uuid::parse_str(&claims.sub).map_err(|_| AppError::Unauthorized)?;
        if !is_platform_admin(state, user_id).await {
            return Err(AppError::Forbidden);
        }
        Ok(PlatformAdmin { user_id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::FromRequestParts;
    use axum::http::header::AUTHORIZATION;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_state() -> AppState {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        AppState {
            pool,
            config: crate::config::Config {
                database_url: "sqlite::memory:".to_string(),
                jwt_secret: "jwt-secret-with-at-least-thirty-two-bytes".to_string(),
                key_encryption_secret: "key-secret-with-at-least-thirty-two-bytes".to_string(),
                bind_addr: "127.0.0.1:0".to_string(),
                cors_allowed_origins: Vec::new(),
                platform_admin_email: None,
            },
            http: reqwest::Client::new(),
        }
    }

    #[tokio::test]
    async fn tenant_ctx_uses_active_membership_role_from_database() {
        let state = test_state().await;
        let user_id = Uuid::new_v4();
        let tenant_id = Uuid::new_v4();
        insert_user_and_tenant(&state, user_id, tenant_id, "member").await;
        let token = issue_token(
            &state.config.jwt_secret,
            &user_id.to_string(),
            Some(&tenant_id.to_string()),
            Some("owner"),
        )
        .unwrap();
        let request = axum::http::Request::builder()
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .body(())
            .unwrap();
        let (mut parts, _) = request.into_parts();

        let ctx = TenantCtx::from_request_parts(&mut parts, &state)
            .await
            .unwrap();

        assert_eq!(ctx.role, "member");
    }

    async fn insert_user_and_tenant(state: &AppState, user_id: Uuid, tenant_id: Uuid, role: &str) {
        sqlx::query(
            "INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,$2,'User','hash')",
        )
        .bind(user_id)
        .bind(format!("{user_id}@example.test"))
        .execute(&state.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO tenants (id,name,slug,owner_user_id) VALUES ($1,'Tenant',$2,$3)")
            .bind(tenant_id)
            .bind(format!("tenant-{tenant_id}"))
            .bind(user_id)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO memberships (tenant_id,user_id,role) VALUES ($1,$2,$3)")
            .bind(tenant_id)
            .bind(user_id)
            .bind(role)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}
