pub mod anthropic;
pub mod openai;
pub mod runtime;
pub mod stream;
pub mod tools;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug)]
pub struct SdkCredentials {
    pub api_key: String,
    pub api_url: String,
}
