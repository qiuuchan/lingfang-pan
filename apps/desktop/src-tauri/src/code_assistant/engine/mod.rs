pub mod anthropic;
pub mod openai;
pub mod runtime;
pub mod tools;

#[derive(Clone, Debug)]
pub struct SdkCredentials {
    pub api_key: String,
    pub api_url: String,
}
