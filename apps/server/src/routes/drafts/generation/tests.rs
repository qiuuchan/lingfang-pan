use super::persist::{persist_generation, SaveGenerationInput};
use super::*;
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
            platform_admin_email: None,
        },
        http: reqwest::Client::new(),
    }
}

#[tokio::test]
async fn persist_generation_reports_missing_draft() {
    let state = test_state().await;
    let generated = llm::GeneratedPlugin {
        files: vec![("manifest.json".to_string(), "{}".to_string())],
        diagnostics: vec![("schema".to_string(), "pass".to_string(), "ok".to_string())],
        assistant_note: "ok".to_string(),
        ok: true,
    };

    let err = persist_generation(
        &state,
        &SaveGenerationInput {
            tenant: Uuid::new_v4(),
            id: Uuid::new_v4(),
            prev_turns: &json!([]),
            user_prompt: "prompt",
            generated: &generated,
            started: Utc::now(),
        },
    )
    .await
    .unwrap_err();

    assert_eq!(err.code(), "not_found");
}
