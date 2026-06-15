# Tauri 安装器 NSIS 美化

## Goal

当前 Tauri bundle 元数据全空白、NSIS 零自定义、图标全是 Tauri 默认 logo。本任务补齐 bundle 元数据、配置 NSIS 安装界面美化（图标、横幅、语言、license）、并用项目品牌替换默认图标，使安装器产出专业、品牌一致的 Windows 安装包。

## Context

- `tauri.conf.json`（35 行）：`bundle.targets: ["nsis"]`，`createUpdaterArtifacts: true`，`resources` 映射 builtin-plugins。无 copyright/shortDescription/longDescription/publisher/category，无 `bundle.windows.nsis` 子块，无 `bundle.icon`。
- 图标目录 `apps/desktop/src-tauri/icons/`：全为 Tauri init 默认 logo（icon.ico/icns/png + 各尺寸 + ios/android 全套）。
- `tools/generate_logo.py`：PIL 绘制 1024×1024 品牌图标（靛蓝→紫→天蓝渐变几何 L 标），但仅产出单一尺寸，需扩展以产出 NSIS banner 与多尺寸 icon。
- 无 CI/CD，构建靠 `pnpm -C apps/desktop build`（tauri build）。

## Requirements

- R8.1 补齐 `bundle` 元数据：`productName`(LingFang 已有)、`version`、`identifier` 保持；新增 `copyright`、`shortDescription`、`longDescription`、`publisher`、`category`。
- R8.2 新增 `bundle.windows.nsis` 配置块：
  - `installerIcon`：品牌 ico
  - `headerImage`（顶部横幅，建议 150×57 bmp/png）与/或 `sidebarImage`（侧边图，164×314）
  - `languages`：含 `SimpChinese` 与 `English`（至少简中）
  - `license`（可选，若提供 license.txt 则引用）
- R8.3 用项目品牌替换 `icons/` 下全套图标：扩展 `generate_logo.py` 或新增脚本，从 1024 主图派生 icon.ico（多尺寸打包）、icon.icns、各 PNG 尺寸（32/64/128/128@2x、Square*、StoreLogo、ios、android mipmap）。
- R8.4 banner 资源生成：用 PIL 产出 headerImage/sidebarImage 品牌横幅（渐变 + LingFang 字样 + L 标），放入 `src-tauri/icons/` 或 `src-tauri/nsis/`。
- R8.5 构建可出包：`tauri build` 成功产出 NSIS exe，安装界面显示品牌图标/横幅/简中语言。
- R8.6 license：若有项目 LICENSE 文件则引用；若无，本期可暂不加 license（NSIS 不强制）。

## Acceptance Criteria

- [ ] `tauri.conf.json` bundle 元数据补齐
- [ ] `bundle.windows.nsis` 配置生效（installerIcon/headerImage/languages）
- [ ] `icons/` 替换为品牌图标（不再是 Tauri 默认）
- [ ] `tauri build` 成功产出 NSIS 安装包（本地验证）
- [ ] 安装界面显示简体中文 + 品牌横幅/图标（截图留痕）
- [ ] 不破坏 updater artifacts 与 builtin-plugins resources 打包

## Design

- **图标生成脚本扩展**：增强 `tools/generate_logo.py`（或新增 `tools/generate_icons.py`），参数化输出：1024 主图 → 各 PNG 尺寸 → icon.ico（PIL 组装多尺寸 ICO）；banner 单独函数绘制。
- **NSIS banner 规格**：headerImage 150×57、sidebarImage 164×314（NSIS 现代 UI 标准），bmp 或 png（Tauri 2 支持 png）。
- **配置落点**：所有图片资源放 `apps/desktop/src-tauri/icons/`，`tauri.conf.json` 用相对路径引用。
- **languages**：`["SimpChinese", "English"]`，NSIS 会按系统语言自动选。

## Files

- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/icons/*`（替换 + 新增 banner）
- `tools/generate_logo.py` 或 `tools/generate_icons.py`（扩展/新增）

## Notes

- 中等复杂度。构建验证依赖 Windows 环境 + Rust toolchain，本地 `tauri build` 可能耗时较长。
- 与其他子任务无耦合，可独立推进。
- 注意：icon 替换会影响所有平台图标，确认品牌图确定后再批量生成。
