//! plugin_security.rs — 插件安全与管理（Task 14）。
//!
//! 三项能力：
//! 1. **签名校验**：verify_plugin_signature 用 minisign 非对称验签。插件目录放 manifest.sig
//!    （minisign 文本格式），与 plugins_root/.plugin-pubkey（或 env LINGFANG_PLUGIN_PUBKEY）
//!    配对的公钥验签 manifest.json。未配置公钥 / 无签名文件 → signed=false（不阻断，仅状态展示）。
//! 2. **版本召回**：PluginRecallInfo 描述某插件版本是否被召回（前端据此展示警告，禁止运行）。
//!    召回标记落在 plugins_root/.recalled.json（平台下发），格式 { "<pluginId>": "<version>" }。
//! 3. **系统级权限请求**：SystemPermissionRequest 描述插件请求的系统权限；实际授权由前端用户确认
//!    （此处提供数据结构 + Rust 侧读取请求清单，授权动作在前端 capability 网关完成）。
//!
//! 设计原则：签名/召回均为「可选增强」——未配置时降级为「未签名/未召回」状态，不阻断既有插件加载
//! 与运行（避免破坏 AI 生成插件的工作流：它们默认无签名）。

use std::fs;
use std::path::{Path, PathBuf};

use minisign_verify::{PublicKey, Signature};
use serde::Serialize;

use crate::plugin_store::PluginStore;

/// 签名校验结果（前端展示「已签名验证 / 未签名 / 签名无效」）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSignatureStatus {
    /// 是否存在签名文件（manifest.sig）。
    pub signed: bool,
    /// 签名是否通过验证（signed=false 时恒为 false）。
    pub verified: bool,
    /// 说明（未配置公钥 / 无签名 / 验签失败原因 / 验证通过）。
    pub reason: String,
}

/// 读取插件签名状态：manifest.sig + manifest.json + 配置的公钥。
pub fn verify_plugin_signature(
    store: &PluginStore,
    plugin_id: &str,
) -> Result<PluginSignatureStatus, String> {
    let dir = store.plugin_dir(plugin_id)?;
    verify_plugin_signature_at_dir(&store.plugins_root(), &dir)
}

/// 目录级验签（install/start 强制门禁共用）：
/// - 无签名文件 → signed=false、verified=false（reason 说明缺失）；
/// - 有签名但未配置公钥 → signed=true、verified=false（fail-closed，reason 说明）；
/// - 验签失败 → verified=false。
pub fn verify_plugin_signature_at_dir(
    plugins_root: &Path,
    plugin_dir: &Path,
) -> Result<PluginSignatureStatus, String> {
    let sig_path = plugin_dir.join("manifest.sig");
    let manifest_path = plugin_dir.join("manifest.json");

    if !sig_path.exists() {
        return Ok(PluginSignatureStatus {
            signed: false,
            verified: false,
            reason: "插件未附带签名（manifest.sig 缺失）".into(),
        });
    }
    if !manifest_path.exists() {
        return Ok(PluginSignatureStatus {
            signed: true,
            verified: false,
            reason: "manifest.json 缺失，无法验签".into(),
        });
    }

    // 公钥来源：plugins_root/.plugin-pubkey（优先）或 env LINGFANG_PLUGIN_PUBKEY。
    // 未配置时返回 signed=true 但 verified=false（fail-closed：强制门禁会拒绝远端来源）。
    let pubkey_str = match read_pubkey(plugins_root)? {
        Some(k) => k,
        None => {
            return Ok(PluginSignatureStatus {
                signed: true,
                verified: false,
                reason: "平台未配置插件验签公钥（.plugin-pubkey / LINGFANG_PLUGIN_PUBKEY），fail-closed 拒绝".into(),
            });
        }
    };

    let pubkey = PublicKey::from_base64(&pubkey_str).map_err(|e| format!("公钥格式非法：{e}"))?;
    let sig_text = fs::read_to_string(&sig_path).map_err(|e| format!("读取签名文件失败：{e}"))?;
    let signature = Signature::decode(&sig_text).map_err(|e| format!("签名格式非法：{e}"))?;
    let message = fs::read(&manifest_path).map_err(|e| format!("读取 manifest 失败：{e}"))?;

    match pubkey.verify(&message, &signature, false) {
        Ok(()) => Ok(PluginSignatureStatus {
            signed: true,
            verified: true,
            reason: "签名验证通过".into(),
        }),
        Err(e) => Ok(PluginSignatureStatus {
            signed: true,
            verified: false,
            reason: format!("签名验证失败：{e}"),
        }),
    }
}

/// 强制签名门禁（M-3/P1-2 修复）：install/start 移入 Rust 侧的签名检查，fail-closed。
///
/// 规则：
/// - 草稿插件豁免——但「是否草稿」取自**安装侧基线证明**而非插件自述（P1-3 Step 4，见下）；
/// - require_signed=false（Local/Builtin 安装）：不拦无签名，仅状态展示；
/// - require_signed=true（Team/Marketplace 远端链路）：必须 signed && verified，
///   无签名 / 未配置公钥 / 验签失败一律拒绝安装或启动。
pub fn enforce_signature_gate(
    plugins_root: &Path,
    plugin_dir: &Path,
    require_signed: bool,
) -> Result<(), String> {
    let (manifest, bytes) = read_manifest(plugin_dir)?;
    let self_draft = manifest
        .get("draft")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if resolve_draft_exemption(plugins_root, plugin_dir, self_draft, &bytes)? {
        return Ok(());
    }
    let status = verify_plugin_signature_at_dir(plugins_root, plugin_dir)?;
    if require_signed && !status.verified {
        return Err(format!(
            "插件签名校验未通过，拒绝安装/启动：{}（fail-closed）",
            status.reason
        ));
    }
    Ok(())
}

/// 暂存目录版门禁（安装落盘前对 staging/package 校验）：
///
/// 与 [`enforce_signature_gate`] 的差别有二，都是收紧而非放松：
/// 1. **不认草稿豁免**——该通道只服务 Team/Marketplace 远端来源，发布链路已剥离 draft 标记，
///    带 `draft:true` 的远端包本身就是绕过签名的攻击面；
/// 2. **不写基线证明**——staging 目录随即被 rename/删除，写进去只会留下孤儿记录；
///    最终目录的基线在首次启动时以 TOFU 方式建立。
pub fn enforce_signature_gate_staged(
    plugins_root: &Path,
    plugin_dir: &Path,
    require_signed: bool,
) -> Result<(), String> {
    read_manifest(plugin_dir)?;
    let status = verify_plugin_signature_at_dir(plugins_root, plugin_dir)?;
    if require_signed && !status.verified {
        return Err(format!(
            "插件签名校验未通过，拒绝安装/启动：{}（fail-closed）",
            status.reason
        ));
    }
    Ok(())
}

fn read_manifest(plugin_dir: &Path) -> Result<(serde_json::Value, Vec<u8>), String> {
    let bytes = fs::read(plugin_dir.join("manifest.json"))
        .map_err(|_| "插件 manifest.json 缺失，拒绝安装/启动".to_string())?;
    let manifest: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "插件 manifest.json 解析失败，拒绝安装/启动".to_string())?;
    Ok((manifest, bytes))
}

// === 清单基线证明（P1-3 Step 4：防自我提权 / R2） ===
//
// 问题：旧门禁的草稿豁免读的是 `manifest.draft`，而 manifest.json 就躺在插件自己的目录里。
// 已装插件运行时把自己的 manifest 改成 `"draft": true`，下次启动即可整段跳过签名强制——
// 插件用一行自述给自己发了免检牌，这是典型的自我提权。
//
// 修复：草稿身份改由**框架侧**记录，落在 `plugins_root/.lingfang/attest/<key>.json`。
// - 该隐藏段被 sanitize_plugin_id 拒绝，插件经框架文件写入 API（write_plugin_file /
//   Agent Write / 云端同步）无论如何都够不着；
// - 首见插件按 TOFU 立基线（既有草稿工作流零变更）；
// - 已记为正式插件的，manifest 再声明 draft 一律判定为提权企图并拒绝；
// - 授权的身份变更只有一条路：[`mark_manifest_attestation`]（由 PluginStore::set_draft_flag 调用）。
//
// 边界（诚实说明）：本步只闭合**逻辑层**的自述信任。插件进程当前仍有完整文件系统权限，
// 理论上可越过框架 API 直接改写 attest 文件——那属于 OS 层，由 P1-3 Step 2（降权令牌）覆盖。

/// 基线证明记录：插件的框架侧身份 + 建立基线时的 manifest 摘要。
#[derive(Clone, Debug, serde::Deserialize, Serialize)]
struct ManifestAttestation {
    /// 框架侧认定的草稿身份（唯一有效的豁免依据）。
    draft: bool,
    /// 记录基线时 manifest.json 的 sha256（用于识别就地改写）。
    manifest_sha256: String,
}

/// 证明文件路径：`plugins_root/.lingfang/attest/<插件目录路径摘要>.json`。
///
/// 用路径摘要而非 plugin_id 作键：门禁同时服务 plugins_root 下的目录与 installed/releases
/// 下的发行版目录，只有绝对路径是共同的稳定标识；摘要同时规避了路径字符转义问题。
fn attestation_path(plugins_root: &Path, plugin_dir: &Path) -> PathBuf {
    let canonical = fs::canonicalize(plugin_dir).unwrap_or_else(|_| plugin_dir.to_path_buf());
    let key = crate::plugin_artifact_v4::sha256_bytes(
        canonical.to_string_lossy().to_lowercase().as_bytes(),
    );
    plugins_root
        .join(".lingfang")
        .join("attest")
        .join(format!("{}.json", &key[..32]))
}

fn load_attestation(plugins_root: &Path, plugin_dir: &Path) -> Option<ManifestAttestation> {
    let raw = fs::read_to_string(attestation_path(plugins_root, plugin_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 写入基线证明（tmp+rename 原子替换）。目录创建失败等 IO 错误直接上抛：
/// 基线写不进去却放行，等于门禁形同虚设。
fn save_attestation(
    plugins_root: &Path,
    plugin_dir: &Path,
    record: &ManifestAttestation,
) -> Result<(), String> {
    let path = attestation_path(plugins_root, plugin_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建插件证明目录失败：{e}"))?;
    }
    let body = serde_json::to_vec(record).map_err(|e| format!("序列化插件证明失败：{e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &body).map_err(|e| format!("写入插件证明失败：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("提交插件证明失败：{e}")
    })
}

/// 判定草稿豁免是否成立（唯一入口，见本节顶部注释）。
fn resolve_draft_exemption(
    plugins_root: &Path,
    plugin_dir: &Path,
    self_draft: bool,
    manifest_bytes: &[u8],
) -> Result<bool, String> {
    let digest = crate::plugin_artifact_v4::sha256_bytes(manifest_bytes);
    match load_attestation(plugins_root, plugin_dir) {
        // 首见：以当前状态立基线（TOFU）。既有 AI 草稿/本地插件工作流零行为变更。
        None => {
            save_attestation(
                plugins_root,
                plugin_dir,
                &ManifestAttestation {
                    draft: self_draft,
                    manifest_sha256: digest,
                },
            )?;
            Ok(self_draft)
        }
        // 已记为草稿：允许继续编辑（摘要随之刷新），也允许 draft→false 的发布（权限收紧）。
        Some(base) if base.draft => {
            if base.manifest_sha256 != digest || base.draft != self_draft {
                save_attestation(
                    plugins_root,
                    plugin_dir,
                    &ManifestAttestation {
                        draft: self_draft,
                        manifest_sha256: digest,
                    },
                )?;
            }
            Ok(self_draft)
        }
        // 已记为正式插件：自述 draft 即提权企图，拒绝。
        Some(base) => {
            if self_draft {
                return Err(
                    "插件 manifest.json 自行标记为草稿以绕过签名校验（安装时记录为正式插件），拒绝启动"
                        .to_string(),
                );
            }
            if base.manifest_sha256 != digest {
                // 正式插件的 manifest 被改写：签名校验会在后续步骤给出结论（已签名插件必然验签失败），
                // 此处只刷新摘要，避免对 Local 安装的合法编辑造成误伤。
                save_attestation(
                    plugins_root,
                    plugin_dir,
                    &ManifestAttestation {
                        draft: false,
                        manifest_sha256: digest,
                    },
                )?;
            }
            Ok(false)
        }
    }
}

/// 授权的草稿身份变更（P1-3 Step 4）：由 `PluginStore::set_draft_flag` 在写完 manifest 后调用。
///
/// 这是把插件标记成草稿的唯一合法通路——命令层入口，插件进程无法经框架 API 触达。
pub fn mark_manifest_attestation(
    plugins_root: &Path,
    plugin_dir: &Path,
    draft: bool,
) -> Result<(), String> {
    let bytes = fs::read(plugin_dir.join("manifest.json"))
        .map_err(|e| format!("读取 manifest 失败：{e}"))?;
    save_attestation(
        plugins_root,
        plugin_dir,
        &ManifestAttestation {
            draft,
            manifest_sha256: crate::plugin_artifact_v4::sha256_bytes(&bytes),
        },
    )
}

/// 公钥读取：plugins_root/.plugin-pubkey（单行 base64）> env LINGFANG_PLUGIN_PUBKEY > None。
fn read_pubkey(plugins_root: &Path) -> Result<Option<String>, String> {
    let path: PathBuf = plugins_root.join(".plugin-pubkey");
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("读取公钥文件失败：{e}"))?;
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(Some(trimmed.to_string()));
        }
    }
    Ok(std::env::var("LINGFANG_PLUGIN_PUBKEY")
        .ok()
        .filter(|s| !s.is_empty()))
}

// === 版本召回 ===

/// 召回表：plugins_root/.recalled.json，{ "<pluginId>": "<被召回的版本号>" }。
/// 前端据此对已安装的对应版本展示警告并禁用运行（「版本召回」能力）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecallInfo {
    pub recalled: bool,
    /// 被召回的版本（recalled=false 时为空）。
    pub version: String,
    /// 召回原因（可选，来自 .recalled.json 的 "_reason_<id>"）。
    pub reason: String,
}

/// 查询某插件当前安装版本是否被召回。
pub fn check_plugin_recall(
    store: &PluginStore,
    plugin_id: &str,
    installed_version: &str,
) -> PluginRecallInfo {
    let path = store.plugins_root().join(".recalled.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return PluginRecallInfo {
            recalled: false,
            version: String::new(),
            reason: String::new(),
        };
    };
    let Ok(map) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return PluginRecallInfo {
            recalled: false,
            version: String::new(),
            reason: String::new(),
        };
    };
    let recalled_version = map.get(plugin_id).and_then(|v| v.as_str()).unwrap_or("");
    if recalled_version.is_empty() {
        return PluginRecallInfo {
            recalled: false,
            version: String::new(),
            reason: String::new(),
        };
    }
    if recalled_version != installed_version {
        // 该插件有被召回的版本，但当前安装版本不同 → 不影响。
        return PluginRecallInfo {
            recalled: false,
            version: String::new(),
            reason: String::new(),
        };
    }
    let reason_key = format!("_reason_{plugin_id}");
    let reason = map
        .get(&reason_key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    PluginRecallInfo {
        recalled: true,
        version: recalled_version.to_string(),
        reason,
    }
}

// === Tauri 命令封装（供前端 invoke） ===

/// 命令：校验插件签名（Task 14）。未配置公钥/无签名时返回 signed=false，不抛错。
#[tauri::command]
pub fn verify_plugin_signature_command(
    store: tauri::State<'_, PluginStore>,
    plugin_id: String,
) -> Result<PluginSignatureStatus, String> {
    verify_plugin_signature(&store, &plugin_id)
}

/// 命令：查询插件版本是否被召回（Task 14）。installed_version 由前端从 manifest 读出后传入。
#[tauri::command]
pub fn check_plugin_recall_command(
    store: tauri::State<'_, PluginStore>,
    plugin_id: String,
    installed_version: String,
) -> Result<PluginRecallInfo, String> {
    Ok(check_plugin_recall(&store, &plugin_id, &installed_version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_store::PluginStore;

    fn temp_store(name: &str) -> PluginStore {
        let root = std::env::temp_dir().join(format!(
            "lingfang-plugin-security-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        PluginStore::new(&root).unwrap()
    }

    #[test]
    fn unsigned_plugin_reports_unsigned() {
        let store = temp_store("unsigned");
        let dir = store.plugin_dir("p1").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"id":"p1"}"#).unwrap();
        let status = verify_plugin_signature(&store, "p1").unwrap();
        assert!(!status.signed);
        assert!(!status.verified);
        assert!(status.reason.contains("签名"));
    }

    #[test]
    fn enforce_gate_rejects_unsigned_non_draft_remote_plugin() {
        let store = temp_store("gate-unsigned");
        let dir = store.plugin_dir("remote-pkg").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"id":"remote-pkg"}"#).unwrap();
        let error = enforce_signature_gate(&store.plugins_root(), &dir, true).unwrap_err();
        assert!(error.contains("manifest.sig"));
    }

    #[test]
    fn enforce_gate_allows_draft_plugin_without_signature() {
        let store = temp_store("gate-draft");
        let dir = store.plugin_dir("draft-pkg").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"id":"draft-pkg","draft":true}"#).unwrap();
        enforce_signature_gate(&store.plugins_root(), &dir, true).unwrap();
    }

    #[test]
    fn enforce_gate_allows_local_install_without_signature() {
        let store = temp_store("gate-local");
        let dir = store.plugin_dir("local-pkg").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"id":"local-pkg"}"#).unwrap();
        enforce_signature_gate(&store.plugins_root(), &dir, false).unwrap();
    }

    /// R2 回归：已记为正式插件的插件，运行时把自己的 manifest 改成 draft:true 想跳过签名 → 必须拒绝。
    #[test]
    fn self_declared_draft_cannot_bypass_gate_after_baseline() {
        let store = temp_store("gate-self-escalate");
        let dir = store.plugin_dir("evil-pkg").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = dir.join("manifest.json");
        // 第一次：正式（非草稿）本地插件，require_signed=false 放行，同时立下基线。
        std::fs::write(&manifest, r#"{"id":"evil-pkg"}"#).unwrap();
        enforce_signature_gate(&store.plugins_root(), &dir, false).unwrap();
        // 插件自我提权：改写自己的 manifest 声明为草稿。
        std::fs::write(&manifest, r#"{"id":"evil-pkg","draft":true}"#).unwrap();
        let error = enforce_signature_gate(&store.plugins_root(), &dir, true).unwrap_err();
        assert!(error.contains("自行标记为草稿"), "实际错误：{error}");
    }

    /// 草稿工作流零变更：首见即立草稿基线，后续持续编辑 manifest 仍然豁免。
    #[test]
    fn draft_baseline_survives_manifest_edits() {
        let store = temp_store("gate-draft-edit");
        let dir = store.plugin_dir("draft-edit").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = dir.join("manifest.json");
        std::fs::write(&manifest, r#"{"id":"draft-edit","draft":true}"#).unwrap();
        enforce_signature_gate(&store.plugins_root(), &dir, true).unwrap();
        // AI/用户继续编辑草稿 manifest → 摘要变化不应导致拦截。
        std::fs::write(
            &manifest,
            r#"{"id":"draft-edit","draft":true,"title":"改过名"}"#,
        )
        .unwrap();
        enforce_signature_gate(&store.plugins_root(), &dir, true).unwrap();
    }

    /// 授权通路：set_draft_flag(false) 发布后基线转正，此后自述 draft 再也豁免不了。
    #[test]
    fn publishing_draft_revokes_exemption() {
        let store = temp_store("gate-publish");
        let dir = store.plugin_dir("pub-pkg").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"id":"pub-pkg","draft":true}"#).unwrap();
        enforce_signature_gate(&store.plugins_root(), &dir, true).unwrap();
        // 发布：命令层授权变更（写 manifest + 刷新基线）。
        store.set_draft_flag("pub-pkg", false).unwrap();
        enforce_signature_gate(&store.plugins_root(), &dir, false).unwrap();
        // 再自称草稿 → 拒绝。
        std::fs::write(dir.join("manifest.json"), r#"{"id":"pub-pkg","draft":true}"#).unwrap();
        let error = enforce_signature_gate(&store.plugins_root(), &dir, true).unwrap_err();
        assert!(error.contains("自行标记为草稿"), "实际错误：{error}");
    }

    /// 证明文件落在 .lingfang 隐藏段内：插件经框架文件写入 API（sanitize_plugin_id 拒绝隐藏段）够不着。
    #[test]
    fn attestation_lives_under_hidden_metadata_dir() {
        let store = temp_store("gate-attest-path");
        let dir = store.plugin_dir("loc-pkg").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"id":"loc-pkg"}"#).unwrap();
        enforce_signature_gate(&store.plugins_root(), &dir, false).unwrap();
        let path = attestation_path(&store.plugins_root(), &dir);
        assert!(path.exists(), "基线证明未落盘：{}", path.display());
        assert!(path.starts_with(store.plugins_root().join(".lingfang").join("attest")));
        // 证明文件不在插件目录内（插件目录对插件自身可写）。
        assert!(!path.starts_with(&dir));
    }

    /// 暂存目录门禁不认草稿豁免：远端包带 draft:true 也必须过签名（否则就是绕过通道）。
    #[test]
    fn staged_gate_ignores_draft_claim() {
        let store = temp_store("gate-staged");
        let dir = store.plugins_root().join("staging").join("package");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"id":"remote","draft":true}"#).unwrap();
        let error = enforce_signature_gate_staged(&store.plugins_root(), &dir, true).unwrap_err();
        assert!(error.contains("manifest.sig"), "实际错误：{error}");
        // 且不留下孤儿证明文件。
        assert!(!attestation_path(&store.plugins_root(), &dir).exists());
    }

    #[test]
    fn recall_detects_matching_version() {
        let store = temp_store("recall");
        std::fs::write(
            store.plugins_root().join(".recalled.json"),
            serde_json::json!({ "vuln-plugin": "1.2.3", "_reason_vuln-plugin": "存在安全漏洞" })
                .to_string(),
        )
        .unwrap();
        // 命中：版本一致 → recalled=true。
        let hit = check_plugin_recall(&store, "vuln-plugin", "1.2.3");
        assert!(hit.recalled);
        assert_eq!(hit.version, "1.2.3");
        assert_eq!(hit.reason, "存在安全漏洞");
        // 未命中：版本不同 → recalled=false。
        let miss = check_plugin_recall(&store, "vuln-plugin", "1.2.4");
        assert!(!miss.recalled);
        // 其它插件不在表里 → recalled=false。
        let other = check_plugin_recall(&store, "other-plugin", "1.0.0");
        assert!(!other.recalled);
    }

    #[test]
    fn recall_missing_table_returns_not_recalled() {
        let store = temp_store("no-recall-table");
        // 无 .recalled.json → 全部 not recalled，不报错。
        let info = check_plugin_recall(&store, "any", "1.0.0");
        assert!(!info.recalled);
    }
}
