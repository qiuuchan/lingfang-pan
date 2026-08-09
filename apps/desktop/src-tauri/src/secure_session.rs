//! session.json 凭据加密（P1-3 / M-2 Step 1.5，R1 子项拆分）。
//!
//! **目标**：消除「同用户子进程直读明文 JWT」（R1 最高危缺口）中的「明文落盘」部分——
//! token 在磁盘上不再以明文存在。
//!
//! **Windows 实现**（`cfg(windows)`）：
//! - `encrypt_token`：经 DPAPI `CryptProtectData` 加密后 base64，落盘写入 `token_enc` 字段。
//!   DPAPI 以当前用户登录会话为密钥，磁盘上是密文，任何 `open()` 直读只能拿到密文；
//!   要还原 token 必须显式调用 `CryptUnprotectData`，抬高了插件子进程窃取的门槛。
//! - `harden_file_acl`：把文件 DACL 设为仅当前用户完全控制且不可继承（PROTECTED_DACL），
//!   挡掉其他用户/其他账户进程。best-effort：失败仅记录，不阻断写入
//!   （DPAPI 已保证内容非明文，默认 app_data 仍限制其他用户）。
//!
//! **Unix**：权限（0600）由 `main.rs::persist_auth_token` 处理，本模块完全不接管。
//!
//! **兼容性**：读路径（`main.rs::read_auth_token`）优先解 `token_enc`，失败/旧版 `token`
//! 明文文件回退，保证升级平滑。

use std::path::Path;

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

    /// 明文 token → base64(DPAPI 密文)。失败返回错误（调用方应中断写入）。
    pub(crate) fn encrypt_token(plain: &str) -> Result<String, String> {
        let bytes = plain.as_bytes();
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                std::ptr::null(),
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
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                std::ptr::null(),
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
