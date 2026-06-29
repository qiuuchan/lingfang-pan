// build.rs —— Windows 构建：嵌入 VERSIONINFO 资源到 installer.exe。
//
// 为什么：未签名 + 无版本元数据的 EXE 易被杀软启发式判定为「匿名 dropper」
// （installer 的自解压行为本身像 dropper）。补合法 VERSIONINFO（公司/产品/版本/描述）
// 让 PE 文件属性显示正规软件元数据，降低误报概率（非根治，签名才是根治）。
//
// 仅 Windows 生效；其它平台 build.rs 是 no-op。
fn main() {
    #[cfg(target_os = "windows")]
    {
        let mut res = winres::WindowsResource::new();
        // 与 paths.rs / tauri.conf.json 对齐的显示信息。
        res.set("FileDescription", "灵坊工作台 安装程序");
        res.set("ProductName", "灵坊工作台");
        res.set("LegalCopyright", "© 2026 灵坊工作台");
        res.set("CompanyName", "灵坊工作台");
        // 版本号从 Cargo.toml 读（build.rs 环境变量 CARGO_PKG_VERSION），保持与包版本一致。
        let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0.0".to_string());
        res.set("ProductVersion", &version);
        res.set("FileVersion", &version);
        // 原始版本四元组（winres 默认从 ProductVersion 解析；这里显式确保格式合法）。
        // 若解析失败（如含非数字），winres 会用 0.0.0.0 兜底，不影响构建。
        if let Err(e) = res.compile() {
            // 资源编译失败不应阻断构建（如缺 rc.exe 工具链）——降级为无资源 exe。
            println!("cargo:warning=winres 编译 VERSIONINFO 失败（降级为无资源）：{e}");
        }
    }
    println!("cargo:rerun-if-changed=build.rs");
}
