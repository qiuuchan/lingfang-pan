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
    #[error("余额不足")]
    InsufficientBalance,
    #[error("需先购买")]
    PaymentRequired,
    #[error("租户未配置 LLM 网关")]
    LlmBindingMissing,
    #[error("生成结果非法: {0}")]
    GenerationInvalid(String),
    #[error("上游 LLM 网关错误: {0}")]
    UpstreamLlm(String),
    #[error("内部错误: {0}")]
    Internal(String),
}

impl AppError {
    /// 稳定错误码（与 contract ErrorCode 对齐），用于审计与日志。
    pub fn code(&self) -> &'static str {
        self.parts().1
    }

    fn parts(&self) -> (StatusCode, &'static str) {
        match self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::CapabilityDenied => (StatusCode::FORBIDDEN, "capability_denied"),
            AppError::InsufficientBalance => (StatusCode::PAYMENT_REQUIRED, "insufficient_balance"),
            AppError::PaymentRequired => (StatusCode::PAYMENT_REQUIRED, "payment_required"),
            AppError::LlmBindingMissing => (StatusCode::BAD_REQUEST, "llm_binding_missing"),
            AppError::GenerationInvalid(_) => {
                (StatusCode::UNPROCESSABLE_ENTITY, "generation_invalid")
            }
            AppError::UpstreamLlm(_) => (StatusCode::BAD_GATEWAY, "upstream_llm_error"),
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
