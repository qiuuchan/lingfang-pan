//! 统一错误类型与 HTTP 映射。错误码与 contract 的 ErrorCode 对齐（显式失败，不伪造结果）。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("未授权")]
    Unauthorized,
    #[error("禁止访问")]
    Forbidden,
    #[error("未找到")]
    NotFound,
    #[error("请求无效: {0}")]
    BadRequest(String),
    #[error("能力被拒")]
    CapabilityDenied,
    #[error("需先购买")]
    PaymentRequired,
    #[error("生成结果非法: {0}")]
    GenerationInvalid(String),
    #[error("内部错误: {0}")]
    Internal(String),
}

impl AppError {
    fn parts(&self) -> (StatusCode, &'static str) {
        match self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::CapabilityDenied => (StatusCode::FORBIDDEN, "capability_denied"),
            AppError::PaymentRequired => (StatusCode::PAYMENT_REQUIRED, "payment_required"),
            AppError::GenerationInvalid(_) => {
                (StatusCode::UNPROCESSABLE_ENTITY, "generation_invalid")
            }
            AppError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = self.parts();
        let body = Json(json!({ "error": code, "message": self.to_string() }));
        (status, body).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => AppError::NotFound,
            other => AppError::Internal(other.to_string()),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;