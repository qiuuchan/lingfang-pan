//! 数据库连接池与迁移。

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;

/// 连接内嵌 SQLite 并跑迁移；任一失败直接 panic 退出（启动期硬失败）。
/// 连接串缺省时由 config 提供 `sqlite://lingfang.db?mode=rwc`，文件不存在则自动创建。
pub async fn connect_and_migrate(database_url: &str) -> SqlitePool {
    // create_if_missing 确保首次运行自动建库文件；启用 WAL 提升并发读写表现。
    let options = SqliteConnectOptions::from_str(database_url)
        .expect("解析 DATABASE_URL 失败")
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(options)
        .await
        .expect("连接 SQLite 失败");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("数据库迁移失败");

    pool
}

/// 按邮箱标记平台审核员（幂等）。邮箱不存在仅告警，不阻断启动——
/// 审核员账户可能晚于服务首启注册，下次重启会自动补标。
pub async fn seed_platform_admin(pool: &SqlitePool, email: &str) {
    let affected = sqlx::query("UPDATE users SET is_platform_admin = 1 WHERE email = ?")
        .bind(email)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0);
    if affected == 0 {
        tracing::warn!("平台审核员邮箱 {email} 尚未注册，跳过标记（注册后重启服务即生效）");
    } else {
        tracing::info!("已标记平台审核员：{email}");
    }
}
