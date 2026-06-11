//! 运行配置：全部来自环境变量。
//! 默认使用内嵌 SQLite（单文件、零安装），无需任何外部数据库即可启动。

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    /// 用于加密租户的第三方 LLM key（落库密文）。
    pub key_encryption_secret: String,
    pub bind_addr: String,
    /// 平台审核员邮箱：启动时据此标记 users.is_platform_admin（未配置则无审核员）。
    pub platform_admin_email: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{name} 配置无效: {message}")]
pub struct ConfigError {
    name: &'static str,
    message: String,
}

impl ConfigError {
    pub fn name(&self) -> &'static str {
        self.name
    }
}

impl Config {
    pub fn from_env() -> Self {
        // 默认 SQLite 数据文件（随服务自动创建）；可用 DATABASE_URL 覆盖为自定义路径。
        // 相对路径用单冒号写法 `sqlite:file`（`sqlite://file` 会把 file 误解析为 host）。
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "sqlite:lingfang.db?mode=rwc".to_string());
        let jwt_secret =
            std::env::var("JWT_SECRET").unwrap_or_else(|_| "dev-insecure-jwt-secret".to_string());
        let key_encryption_secret = std::env::var("KEY_ENCRYPTION_SECRET")
            .unwrap_or_else(|_| "dev-insecure-key-encryption-secret".to_string());
        let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
        let platform_admin_email = std::env::var("PLATFORM_ADMIN_EMAIL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Self {
            database_url,
            jwt_secret,
            key_encryption_secret,
            bind_addr,
            platform_admin_email,
        }
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        validate_secret("JWT_SECRET", &self.jwt_secret)?;
        validate_secret("KEY_ENCRYPTION_SECRET", &self.key_encryption_secret)
    }
}

const MIN_SECRET_LEN: usize = 32;

fn validate_secret(name: &'static str, value: &str) -> Result<(), ConfigError> {
    let trimmed = value.trim();
    let blocked = [
        "dev-change-me",
        "dev-insecure-jwt-secret",
        "dev-insecure-key-encryption-secret",
    ];
    if blocked.contains(&trimmed) || trimmed.contains("dev-change-me") {
        return Err(ConfigError {
            name,
            message: "不能使用开发占位密钥".to_string(),
        });
    }
    if trimmed.chars().count() < MIN_SECRET_LEN {
        return Err(ConfigError {
            name,
            message: format!("长度至少需要 {MIN_SECRET_LEN} 个字符"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_config() -> Config {
        Config {
            database_url: "sqlite::memory:".to_string(),
            jwt_secret: "jwt-secret-with-at-least-thirty-two-bytes".to_string(),
            key_encryption_secret: "key-secret-with-at-least-thirty-two-bytes".to_string(),
            bind_addr: "127.0.0.1:0".to_string(),
            platform_admin_email: None,
        }
    }

    #[test]
    fn validate_rejects_placeholder_jwt_secret() {
        let mut config = valid_config();
        config.jwt_secret = "dev-change-me".to_string();

        let err = config.validate().unwrap_err();

        assert_eq!(err.name(), "JWT_SECRET");
    }

    #[test]
    fn validate_rejects_short_key_encryption_secret() {
        let mut config = valid_config();
        config.key_encryption_secret = "short".to_string();

        let err = config.validate().unwrap_err();

        assert_eq!(err.name(), "KEY_ENCRYPTION_SECRET");
    }
}
