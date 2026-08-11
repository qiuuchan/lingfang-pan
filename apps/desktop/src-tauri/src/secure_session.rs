//! session.json 凭据加密（P1-3 / M-2 Step 1.5，R1 子项拆分）。
//!
//! **目标**：消除「同用户子进程直读明文 JWT」（R1 最高危缺口）中的「明文落盘」部分——
//! token 在磁盘上不再以明文存在。
//!
//! **Windows 实现**（`cfg(windows)`）：
//! - `encrypt_token`：经 DPAPI `CryptProtectData` 加密后 base64，落盘写入 `token_enc` 字段。
//!   DPAPI 以当前用户登录会话为密钥，磁盘上是密文，任何 `open()` 直读只能拿到密文；
//!   要还原 token 必须显式调用 `CryptUnprotectData`，抬高了插件子进程窃取的门槛。
//!   P1-6 起额外绑定应用专属 `pOptionalEntropy`（见 `SESSION_ENTROPY`），使同用户下的
//!   其他进程既解不开我们的密文，也伪造不出我们会接受的会话文件。
//! - `harden_file_acl`：把文件 DACL 设为仅当前用户完全控制且不可继承（PROTECTED_DACL），
//!   挡掉其他用户/其他账户进程。best-effort：失败仅记录，不阻断写入
//!   （DPAPI 已保证内容非明文，默认 app_data 仍限制其他用户）。
//!
//! **Unix**：权限（0600）由 `main.rs::persist_auth_token` 处理，本模块完全不接管。
//!
//! **兼容性（NEW-4 / P1-6 修订）**：读路径由本模块的 `read_session_file` 统一处理。
//! Windows 上**只**认 `token_enc`；明文 `token` 字段、旧版无 entropy 密文、损坏文件
//! 一律拒绝 + 清文件 + 要求重新登录（见 `read_session_file` 注释）。

use std::path::Path;

/// 会话文件读取结果（NEW-4）。
///
/// 不用 `Option<String>` 表达：「文件在、但不可信」（明文伪造 / 旧格式密文 / 损坏）必须与
/// 「本来就没登录」区分开——前者要清掉文件并让前端提示重新登录，后者什么都不做。
pub(crate) enum SessionRead {
    /// 无会话：文件不存在，或文件里没有任何可用的 token 字段。
    None,
    /// 会话有效。
    Token(String),
    /// 会话文件已被拒绝并清除，前端应提示重新登录（附带原因，仅用于日志/提示）。
    ReauthRequired(String),
}

/// 前端据此识别「需重新登录」的错误码前缀（`read_auth_token` 返回 Err 时携带）。
pub(crate) const REAUTH_REQUIRED_CODE: &str = "SESSION_REAUTH_REQUIRED";

/// 拒绝一份会话文件：删除它并返回重登信号。
///
/// P1-6：旧版（无 entropy）密文解不开时此前是 `Ok(None)` 静默登出——陈旧文件留在盘上，
/// 每次启动重复解密失败刷 stderr，用户也拿不到任何提示。现在与明文拒绝共用同一套处置。
/// 删除失败只记录不升级为错误：无论文件删没删掉，本次都不会产生登录态。
fn reject_session(path: &Path, reason: impl Into<String>) -> SessionRead {
    let reason = reason.into();
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[session] 清除失效会话文件失败：{e}");
        }
    }
    SessionRead::ReauthRequired(reason)
}

/// Windows：只接受 DPAPI 密文，明文/旧格式一律拒绝。
///
/// NEW-4：本平台的写路径（`main.rs::persist_auth_token`）只会写 `token_enc`，所以磁盘上
/// 出现明文 `token` 字段只有一种解释——会话文件被改写过。此前的「明文兜底」让同用户下的
/// 任意进程（含被攻破的插件子进程）塞一个伪造 JWT 进去、应用启动即以该身份登录：
/// `harden_file_acl` 只挡其他用户，entropy 只挡密文伪造，明文这条通道整个是敞开的。
#[cfg(windows)]
fn read_token_field(path: &Path, value: &serde_json::Value) -> SessionRead {
    // 只要出现 token 字段就判篡改：我们从不写它，合法文件里不可能有。
    if value.get("token").is_some() {
        return reject_session(
            path,
            "检测到明文 token 字段（本平台只写 DPAPI 密文），会话文件疑似被篡改",
        );
    }
    let Some(b64) = value.get("token_enc").and_then(|v| v.as_str()) else {
        // 两个字段都没有：不是「旧格式」，只是没有会话，别误伤。
        return SessionRead::None;
    };
    match decrypt_token(b64) {
        Ok(t) if !t.trim().is_empty() => SessionRead::Token(t),
        Ok(_) => reject_session(path, "DPAPI 解密结果为空"),
        // 典型来源：P1-6 之前写下的无 entropy 密文，或被替换过的 blob。
        Err(e) => reject_session(path, format!("DPAPI 解密失败（旧格式或已被篡改）：{e}")),
    }
}

/// 非 Windows：写路径写的就是明文 + 0600，机密性由文件权限保证，明文字段照常接受。
#[cfg(not(windows))]
fn read_token_field(_path: &Path, value: &serde_json::Value) -> SessionRead {
    match value.get("token").and_then(|v| v.as_str()) {
        Some(t) if !t.trim().is_empty() => SessionRead::Token(t.to_string()),
        _ => SessionRead::None,
    }
}

/// 从指定路径读会话文件（`main.rs::read_auth_token` 的纯逻辑部分，便于单测传入临时路径）。
///
/// 返回 `Err` 仅代表 I/O 读失败（文件在但读不动），其余情况都落在 `SessionRead` 三态里。
pub(crate) fn read_session_file(path: &Path) -> Result<SessionRead, String> {
    // 「文件不存在」= 从未登录 / 已登出，不是旧格式，不能触发重登提示。
    if !path.exists() {
        return Ok(SessionRead::None);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("读取会话文件失败：{e}"))?;
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        // 损坏文件同样恢复不出会话，留着只会每次启动重复失败——并入同一套处置路径。
        return Ok(reject_session(path, "会话文件格式损坏"));
    };
    Ok(read_token_field(path, &value))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Security::*;
    use windows_sys::Win32::Security::Authorization::{SE_FILE_OBJECT, SetNamedSecurityInfoW};
    use windows_sys::Win32::Security::Cryptography::*;
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::*;

    // CRYPTPROTECT_UI_FORBIDDEN：禁止弹出 UI（桌面端无交互场景，且避免阻塞）。
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    /// P1-6：DPAPI 的 `pOptionalEntropy`（次要熵）。
    ///
    /// 不传 entropy 时，密文只以「当前用户登录会话」为界——同一用户下的**任何**进程
    /// （含被攻破的插件子进程）调一次 `CryptUnprotectData` 就能还原 token，磁盘加密形同虚设。
    /// 绑上应用专属 entropy 后，只有同时知道这串常量的调用方才解得开。
    ///
    /// 定位要说清楚：常量编译进二进制，逆向即可提取，**它不是密钥**。它的作用是
    /// (1) 挡掉「无差别扫 DPAPI blob」的通用窃密程序；
    /// (2) 让其他进程无法伪造/替换一份我们会接受的会话文件（注入他人 token）。
    /// 真正的机密性边界仍是 DPAPI 的用户作用域。
    const SESSION_ENTROPY: &[u8] = b"lingfang.desktop.session-token.v1";

    fn entropy_blob() -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: SESSION_ENTROPY.len() as u32,
            pbData: SESSION_ENTROPY.as_ptr() as *mut u8,
        }
    }

    /// 明文 token → base64(DPAPI 密文)。失败返回错误（调用方应中断写入）。
    pub(crate) fn encrypt_token(plain: &str) -> Result<String, String> {
        let bytes = plain.as_bytes();
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let entropy = entropy_blob();
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 {
            return Err(format!(
                "CryptProtectData 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        let raw =
            unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
        // 密文由 LocalAlloc 分配，必须释放。
        unsafe {
            let _ = LocalFree(out_blob.pbData as HLOCAL);
        }
        Ok(B64.encode(raw))
    }

    /// base64(DPAPI 密文) → 明文 token。失败返回错误（调用方据此回退或当无会话）。
    pub(crate) fn decrypt_token(b64: &str) -> Result<String, String> {
        let raw = B64
            .decode(b64.trim())
            .map_err(|e| format!("会话文件 base64 解码失败：{e}"))?;
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: raw.len() as u32,
            pbData: raw.as_ptr() as *mut u8,
        };
        let entropy = entropy_blob();
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // 刻意不给「无 entropy」留回退路径：留了回退就等于宣布「任何同用户进程伪造的
        // 无 entropy blob 我们照收」，token 注入的口子会一直开着。旧版密文解不开时按
        // 无会话处理（read_auth_token 已如此兜底），用户重登一次即完成升级。
        let ok = unsafe {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 {
            return Err(format!(
                "CryptUnprotectData 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        // 先把密文拷到自有缓冲区，再释放 LocalAlloc 分配的内存，保证任何后续失败路径都不泄漏。
        let out_vec =
            unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
        unsafe {
            let _ = LocalFree(out_blob.pbData as HLOCAL);
        }
        let s = String::from_utf8(out_vec).map_err(|e| format!("解密结果非 UTF-8：{e}"))?;
        Ok(s)
    }

    /// 取当前进程 token 所属用户 SID，**拷贝到自有缓冲区后返回**（用于 DACL 仅授权当前用户）。
    ///
    /// 不得把 `GetTokenInformation` 输出的裸 `PSID` 传出去：它指向本函数的局部 `buf`，
    /// 返回即悬垂——`harden_file_acl` 解引用会构成 use-after-free（P1-3 Step 1.5 修复）。
    unsafe fn current_user_sid() -> Result<Vec<u8>, String> {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(format!(
                "OpenProcessToken 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        // 第一次调用取所需缓冲区长度。返回 0 在此处是预期的（ERROR_INSUFFICIENT_BUFFER），
        // 但若查询本身失败、needed 仍为 0，直接报出，避免后面用 0 长度缓冲区掩盖真实原因。
        let mut needed: u32 = 0;
        GetTokenInformation(
            token,
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut needed,
        );
        if needed == 0 {
            let _ = CloseHandle(token);
            return Err(format!(
                "GetTokenInformation 查询缓冲区大小失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        let mut buf = vec![0u8; needed as usize];
        if GetTokenInformation(
            token,
            TokenUser,
            buf.as_mut_ptr() as *mut _,
            needed,
            &mut needed,
        ) == 0
        {
            let _ = CloseHandle(token);
            return Err(format!(
                "GetTokenInformation 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: buf 由 GetTokenInformation 填充，内容为 TOKEN_USER + 紧随其后的可变长度 SID；
        // Vec<u8> 只保证 1 字节对齐，因此用 read_unaligned 读结构体头。
        let token_user = std::ptr::read_unaligned(buf.as_ptr() as *const TOKEN_USER);
        let sid = token_user.User.Sid;
        let _ = CloseHandle(token);
        if sid.is_null() {
            return Err("TokenUser.Sid 为空".to_string());
        }
        // SID 结构位于 buf 内部，buf 在函数返回即 Drop——必须复制到自有缓冲区。
        let sid_len = GetLengthSid(sid);
        let mut owned = vec![0u8; sid_len as usize];
        if CopySid(sid_len, owned.as_mut_ptr() as *mut _, sid) == 0 {
            return Err(format!(
                "CopySid 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(owned)
    }

    /// 把文件 DACL 设为仅当前用户完全控制且不可继承。
    /// best-effort：任何步骤失败都返回 Err，由调用方决定是否记录后继续。
    pub(crate) fn harden_file_acl(path: &Path) -> Result<(), String> {
        unsafe {
            let sid_buf = current_user_sid()?;
            let sid = sid_buf.as_ptr() as PSID;
            let sid_len = GetLengthSid(sid);

            // ACL 缓冲区大小：ACL 头 + 一条 ACCESS_ALLOWED_ACE + SID（ACE 内含 SID，
            // 但 ACCESS_ALLOWED_ACE 的 SizeOfSid 已含 SID 本体，故需减去 ACE 里多算的 4 字节 SID 前缀）。
            let ace_overhead = std::mem::size_of::<ACCESS_ALLOWED_ACE>() - std::mem::size_of::<u32>();
            let acl_size = std::mem::size_of::<ACL>() + ace_overhead + sid_len as usize;
            let mut acl_buf = vec![0u8; acl_size];
            let acl = acl_buf.as_mut_ptr() as *mut ACL;
            if InitializeAcl(acl, acl_size as u32, ACL_REVISION) == 0 {
                return Err(format!(
                    "InitializeAcl 失败：{}",
                    std::io::Error::last_os_error()
                ));
            }
            if AddAccessAllowedAce(acl, ACL_REVISION, FILE_ALL_ACCESS, sid) == 0 {
                return Err(format!(
                    "AddAccessAllowedAce 失败：{}",
                    std::io::Error::last_os_error()
                ));
            }

            // 仅设 DACL 且标记为 PROTECTED（不继承父目录 ACE），挡掉 app_data 可能授予的
            // 其他账户/Users 组权限。失败时返回错误，调用方记录后继续（DPAPI 已保证内容非明文）。
            let info = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
            let wpath: Vec<u16> = OsStr::new(path)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let ret = SetNamedSecurityInfoW(
                wpath.as_ptr(),
                SE_FILE_OBJECT,
                info,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null_mut(),
            );
            if ret != 0 {
                return Err(format!("SetNamedSecurityInfoW 失败：错误码 {ret}"));
            }
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn dpapi_roundtrip_preserves_token() {
            let plain = "eyJhbGciOiJIUzI1Ni.example.signature";
            let enc = encrypt_token(plain).expect("加密应成功");
            assert!(!enc.is_empty());
            // 密文不应含原始明文段。
            assert!(!enc.contains("example"));
            let dec = decrypt_token(&enc).expect("解密应成功");
            assert_eq!(dec, plain);
        }

        #[test]
        fn decrypt_garbage_fails() {
            assert!(decrypt_token("not-a-valid-base64!!!").is_err());
        }

        /// P1-6 回归：不带 entropy 加密出来的密文（= 旧版格式，也是同用户其他进程
        /// 能自行造出来的格式）必须解不开，否则 entropy 等于没加。
        #[test]
        fn decrypt_rejects_blob_protected_without_entropy() {
            let plain = b"eyJhbGciOiJIUzI1Ni.forged.signature";
            let in_blob = CRYPT_INTEGER_BLOB {
                cbData: plain.len() as u32,
                pbData: plain.as_ptr() as *mut u8,
            };
            let mut out_blob = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            let ok = unsafe {
                CryptProtectData(
                    &in_blob,
                    std::ptr::null(),
                    std::ptr::null(), // 关键：不带 entropy
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut out_blob,
                )
            };
            assert_ne!(ok, 0, "构造对照密文应成功");
            let raw = unsafe {
                std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize)
            }
            .to_vec();
            unsafe {
                let _ = LocalFree(out_blob.pbData as HLOCAL);
            }
            assert!(
                decrypt_token(&B64.encode(raw)).is_err(),
                "无 entropy 的密文必须被拒绝"
            );
        }

        #[test]
        fn harden_acl_on_temp_file_succeeds() {
            let dir = std::env::temp_dir();
            let path = dir.join(format!("lf_secure_session_test_{}.tmp", std::process::id()));
            std::fs::write(&path, b"x").expect("写临时文件");
            let result = harden_file_acl(&path);
            let _ = std::fs::remove_file(&path);
            assert!(result.is_ok(), "DACL 加固应成功：{result:?}");
        }
    }
}

#[cfg(windows)]
pub(crate) use imp::{decrypt_token, encrypt_token, harden_file_acl};

#[cfg(test)]
mod session_file_tests {
    use super::*;

    /// 每个用例一份独立临时文件（测试并行执行，不能共用路径）。
    fn temp_path(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "lf_session_{tag}_{}_{nanos}.json",
            std::process::id()
        ))
    }

    /// 不带 entropy 的 DPAPI 加密 = P1-6 之前的旧格式，也是同用户其他进程能自行造出的格式。
    #[cfg(windows)]
    fn protect_without_entropy(plain: &[u8]) -> String {
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine;
        use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
        use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                std::ptr::null(), // 关键：不带 entropy
                std::ptr::null(),
                std::ptr::null(),
                0x1, // CRYPTPROTECT_UI_FORBIDDEN
                &mut out_blob,
            )
        };
        assert_ne!(ok, 0, "构造旧格式密文应成功");
        let raw =
            unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
        unsafe {
            let _ = LocalFree(out_blob.pbData as HLOCAL);
        }
        B64.encode(raw)
    }

    /// NEW-4 反向用例：Windows 上明文 token 必须被拒绝，且文件被清除。
    /// 修复前此处会走「兼容旧版明文」分支返回伪造 JWT，应用启动即以攻击者身份登录。
    #[cfg(windows)]
    #[test]
    fn windows_rejects_plaintext_token_and_clears_file() {
        let path = temp_path("plain");
        std::fs::write(
            &path,
            br#"{"token":"eyJhbGciOiJIUzI1NiJ9.forged-admin.sig"}"#,
        )
        .expect("写入伪造会话文件");

        let outcome = read_session_file(&path).expect("读取不应返回 I/O 错误");
        let cleared = !path.exists();
        let _ = std::fs::remove_file(&path);

        assert!(
            matches!(outcome, SessionRead::ReauthRequired(_)),
            "Windows 上明文 token 必须被拒绝，不得恢复出登录态"
        );
        assert!(cleared, "被拒绝的会话文件必须被清除");
    }

    /// 攻击者可能在合法密文旁追加明文字段试图「二选一」命中兜底：整份文件都判篡改。
    #[cfg(windows)]
    #[test]
    fn windows_rejects_plaintext_even_alongside_valid_ciphertext() {
        let path = temp_path("plain_mixed");
        let enc = encrypt_token("eyJhbGciOiJIUzI1NiJ9.legit.sig").expect("加密应成功");
        let body = serde_json::to_vec(&serde_json::json!({
            "token_enc": enc,
            "token": "eyJhbGciOiJIUzI1NiJ9.forged-admin.sig",
        }))
        .expect("序列化");
        std::fs::write(&path, body).expect("写入会话文件");

        let outcome = read_session_file(&path).expect("读取不应返回 I/O 错误");
        let cleared = !path.exists();
        let _ = std::fs::remove_file(&path);

        assert!(
            matches!(outcome, SessionRead::ReauthRequired(_)),
            "混入明文字段的会话文件必须整体拒绝"
        );
        assert!(cleared, "被拒绝的会话文件必须被清除");
    }

    /// P1-6 兼容用例：旧格式（无 entropy）密文解不开 → 触发重登处置 + 清文件。
    /// 修复前是 Ok(None) 静默登出且文件残留，每次启动重复失败。
    #[cfg(windows)]
    #[test]
    fn windows_rejects_legacy_blob_and_clears_file() {
        let path = temp_path("legacy");
        let legacy = protect_without_entropy(b"eyJhbGciOiJIUzI1NiJ9.legacy.sig");
        let body = serde_json::to_vec(&serde_json::json!({ "token_enc": legacy })).expect("序列化");
        std::fs::write(&path, body).expect("写入旧格式会话文件");

        let outcome = read_session_file(&path).expect("读取不应返回 I/O 错误");
        let cleared = !path.exists();
        let _ = std::fs::remove_file(&path);

        assert!(
            matches!(outcome, SessionRead::ReauthRequired(_)),
            "旧格式密文必须触发重新登录处置"
        );
        assert!(cleared, "旧格式会话文件必须被清除，避免每次启动重复失败");
    }

    /// 正向用例：本版写出的 DPAPI 密文照常恢复，且文件不能被误删。
    #[cfg(windows)]
    #[test]
    fn windows_accepts_dpapi_ciphertext_and_keeps_file() {
        let path = temp_path("ok");
        let plain = "eyJhbGciOiJIUzI1NiJ9.valid.sig";
        let enc = encrypt_token(plain).expect("加密应成功");
        let body = serde_json::to_vec(&serde_json::json!({ "token_enc": enc })).expect("序列化");
        std::fs::write(&path, body).expect("写入会话文件");

        let outcome = read_session_file(&path).expect("读取不应返回 I/O 错误");
        let kept = path.exists();
        let _ = std::fs::remove_file(&path);

        match outcome {
            SessionRead::Token(t) => assert_eq!(t, plain, "应还原出原 token"),
            _ => panic!("合法 DPAPI 密文应恢复出会话"),
        }
        assert!(kept, "有效会话文件不得被清除");
    }

    /// 非 Windows：明文兜底保留（机密性由 0600 权限保证）。
    #[cfg(not(windows))]
    #[test]
    fn unix_accepts_plaintext_token() {
        let path = temp_path("unix_plain");
        std::fs::write(&path, br#"{"token":"eyJhbGciOiJIUzI1NiJ9.valid.sig"}"#).expect("写会话文件");

        let outcome = read_session_file(&path).expect("读取不应返回 I/O 错误");
        let _ = std::fs::remove_file(&path);

        match outcome {
            SessionRead::Token(t) => assert_eq!(t, "eyJhbGciOiJIUzI1NiJ9.valid.sig"),
            _ => panic!("Unix 上明文 token 应继续被接受"),
        }
    }

    /// 文件不存在只是「没登录」，不得被当成旧格式触发重登提示。
    #[test]
    fn missing_file_is_plain_no_session() {
        let path = temp_path("missing");
        let _ = std::fs::remove_file(&path);
        assert!(
            matches!(read_session_file(&path), Ok(SessionRead::None)),
            "文件不存在应判为无会话"
        );
    }

    /// 合法 JSON 但没有任何 token 字段：无会话，也不该被清掉（同样不是旧格式）。
    #[test]
    fn empty_object_is_no_session_and_file_kept() {
        let path = temp_path("empty_obj");
        std::fs::write(&path, b"{}").expect("写会话文件");

        let outcome = read_session_file(&path).expect("读取不应返回 I/O 错误");
        let kept = path.exists();
        let _ = std::fs::remove_file(&path);

        assert!(matches!(outcome, SessionRead::None), "空对象应判为无会话");
        assert!(kept, "无 token 字段的文件不应被误判成旧格式而清除");
    }

    /// 损坏文件并入同一套处置：清文件 + 要求重登。
    #[test]
    fn corrupted_file_triggers_reauth_and_clears_file() {
        let path = temp_path("corrupt");
        std::fs::write(&path, b"{not json").expect("写会话文件");

        let outcome = read_session_file(&path).expect("读取不应返回 I/O 错误");
        let cleared = !path.exists();
        let _ = std::fs::remove_file(&path);

        assert!(
            matches!(outcome, SessionRead::ReauthRequired(_)),
            "损坏文件应触发重新登录处置"
        );
        assert!(cleared, "损坏的会话文件必须被清除");
    }
}
