//! 租户第三方 LLM key 的对称编码（落库密文、仅服务端可解、对外脱敏）。
//!
//! 使用 AES-GCM 做认证加密；密文篡改会导致解密失败。

use aes_gcm::aead::{Aead, AeadCore, OsRng};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use sha2::{Digest, Sha256};

const CIPHER_VERSION: &str = "v1";

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn cipher(secret: &str) -> Aes256Gcm {
    let digest = Sha256::digest(secret.as_bytes());
    Aes256Gcm::new_from_slice(&digest).expect("SHA-256 output is always 32 bytes")
}

/// 明文 -> 密文（落库）。
pub fn encrypt(plaintext: &str, secret: &str) -> String {
    let cipher = cipher(secret);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let encrypted = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .expect("AES-GCM encryption failed");
    format!("{CIPHER_VERSION}:{}:{}", to_hex(&nonce), to_hex(&encrypted))
}

/// 密文 -> 明文（仅服务端转发时使用）。
pub fn decrypt(ciphertext: &str, secret: &str) -> Option<String> {
    let (version, rest) = ciphertext.split_once(':')?;
    if version != CIPHER_VERSION {
        return None;
    }
    let (nonce_hex, data_hex) = rest.split_once(':')?;
    let nonce_bytes = from_hex(nonce_hex)?;
    let data = from_hex(data_hex)?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let decrypted = cipher(secret).decrypt(nonce, data.as_ref()).ok()?;
    String::from_utf8(decrypted).ok()
}

/// 对外脱敏：sk-abc... -> sk-****。
pub fn mask(plaintext: &str) -> String {
    let prefix: String = plaintext.chars().take(3).collect();
    format!("{prefix}****")
}

/// 直接对密文脱敏：解密后取前缀，解不开则回退通用掩码。
pub fn mask_cipher(ciphertext: &str, secret: &str) -> String {
    decrypt(ciphertext, secret)
        .map(|k| mask(&k))
        .unwrap_or_else(|| "****".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let secret = "dev-key-secret-32bytes-padding!";
        let plaintext = "sk-abc123XYZ";
        let cipher = encrypt(plaintext, secret);
        assert_ne!(cipher, plaintext, "密文不应等于明文");
        assert_eq!(decrypt(&cipher, secret).as_deref(), Some(plaintext));
    }

    #[test]
    fn mask_hides_secret() {
        assert_eq!(mask("sk-abcdef"), "sk-****");
    }

    #[test]
    fn ciphertext_is_versioned_and_tamper_evident() {
        let secret = "dev-key-secret-32bytes-padding!";
        let plaintext = "sk-abc123XYZ";
        let cipher = encrypt(plaintext, secret);

        assert!(cipher.starts_with("v1:"));
        let tampered = format!("{cipher}00");
        assert_eq!(decrypt(&tampered, secret), None);
    }
}
