//! 全局应用状态：连接池 + 配置 + 复用的 HTTP 客户端（用于转发到第三方 LLM 网关）。

use crate::config::Config;
use sqlx::SqlitePool;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Config,
    pub http: reqwest::Client,
}
