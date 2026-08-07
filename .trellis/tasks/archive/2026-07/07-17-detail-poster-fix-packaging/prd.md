# 修复详情页海报插件尺寸/颜色图并补全打包资源

## Goal

修复 `detail-poster`（AI详情页海报生成器）测试中暴露的 4 个问题，并把缺失的资源（图标/字体）补进插件包，使插件在桌面壳内开箱即用：选什么比例出什么比例、一键主图 3 个尺寸全出、颜色图工具能正常渲染中文文字、窗口图标正常显示。同时补齐 `outfit-batch` 缺失的窗口图标。

## Background

测试反馈（2026-07-17）：

1. 反推提示词 —— 正常。
2. AI 生图 —— 能出图，但**比例错**：选 1:1 出来是横图。
3. 一键主图（应出 1:1 / 3:4 / 2:3 三张）—— **只生成 2 张**，且都是竖图。
4. 颜色图功能 —— **不能用**。
5. `app.zip` / `favicon (4).zip` / `字体.zip` 三份资源应打包进去。

代码勘察已定位根因（详见 `design.md`）：

- **比例错**：① 尺寸下拉框 `mod.widgets['size']` 从未回写 `mod.size_ratio`，单张生图永远用默认 1:1；② 发给上游的 `size` 是 `"1254x1254"`/`"1440x2160"` 等**自定义像素值**，上游 image-edit 模型不认（忽略→出默认横图，或报错→主图 3 档少出）。
- **颜色图不能用**：`_find_font_file` 只查空的 `BUILTIN_FONTS` 和 `imported_fonts`，找不到则 fallback 到 `ImageFont.load_default()`，该位图字体**渲染不出中文**→文字不可见。原脚本依赖硬编码 `C:\Users\admin\Documents\详情页\*.ttf`，打包时被去掉了，没补回字体来源。
- **资源缺失**：`app.ico`（detail-poster 窗口图标）、`favicon (4).ico`（outfit-batch 窗口图标）、字体（颜色图渲染用）都没打进 `.lfplugin`。

## Requirements

### 功能性

- **R1 比例生效（单张生图）**：模块「尺寸」下拉框（1:1 / 3:4 / 9:16 / 2:3）的选择真实影响出图比例，选 1:1 出正方形、选竖图比例出竖图。
- **R2 一键主图三尺寸**：一键主图按 1:1、3:4、2:3 **各出一张**（共 3 张），且每张比例与选择一致；不再出现只出 2 张或全竖图的情况。
- **R3 颜色图可用**：颜色图工具能渲染中文文字（默认字体「白无常可可体常规」可用），字体下拉框能选到内置字体。
- **R4 窗口图标**：detail-poster 窗口显示 `app.ico`；outfit-batch 窗口显示 `favicon (4).ico`。
- **R5 资源打包**：上述图标 + 全套字体（`字体.zip` 内 25 个字体，方案 B 全量内置）打进对应 `.lfplugin`。

### 约束

- **C1 AI 政策合规不回退**：不得重新引入硬编码密钥/端点；桥变量读取不带 fallback；扫描器对改动后的 manifest + 全部源码仍返回 `ok: true`、零诊断（字体/图标是二进制资源，不触发 AI 扫描）。
- **C2 打包体积合规**：`.lfplugin` 走 `lingfang-plugin build`（不能手搓 zip，v4 需 `_meta.json`）。受打包器硬限制约束：单文件 ≤60MB、总未压缩 ≤300MB、≤1500 文件、产物 ≤300MB。字体总量 ~188MB 未压缩、单文件最大 ~21MB，均在限内。
- **C3 不改桥/relay/AI 政策扫描器**：尺寸问题在插件侧解决（映射到上游支持的标准尺寸 + 必要时客户端裁剪），不动 `plugin_llm_bridge.rs` / `relay.service.ts` / `plugin-ai-policy.ts`。
- **C4 字体许可风险由用户提供**：字体文件来自用户的 `字体.zip`（多为 `_mianfeiziti.com` 免费字体），随插件分发需用户知悉；本任务只负责打包，不审核字体版权。

### 工程

- **E1 版本号**：`manifest.json` version 递增（detail-poster 0.2.3 → 0.2.4；outfit-batch 同步递增）。
- **E2 产物**：重新构建 `plugins/detail-poster.lfplugin` 与 `plugins/outfit-batch.lfplugin`。

## Acceptance Criteria

- [ ] detail-poster 单张生图：尺寸选 1:1 出正方形图；选 2:3 出竖图（宽<高）。下拉框切换后再次生图比例随之改变。
- [ ] detail-poster 一键主图：一次生成 3 张，分别对应 1:1 / 3:4 / 2:3（用图片实际宽高验证，非肉眼）。
- [ ] detail-poster 颜色图：输入中文 → 生成预览中文字符可见（非空白/方块）。
- [ ] detail-poster 窗口标题栏有 `app.ico` 图标；outfit-batch 窗口有 `favicon (4).ico` 图标。
- [ ] `lingfang-plugin build` 成功产出两个 `.lfplugin`；`unzip -l` 可见 `app.ico`/`favicon (4).ico`/字体文件。
- [ ] AI 政策扫描对两插件 manifest + 源码 `ok: true`、零诊断（资源文件不计）。
- [ ] 改动不破坏反推提示词、换装换脸、拼长图、高清修复等既有功能（回归）。

## Out of Scope

- 不改平台桥 / relay / AI 政策扫描器。
- 不重写 GUI 交互（仅修比例/字体/图标的 bug 与资源）。
- 不实现插件自动更新/市场发布（仅本地 `.lfplugin` 产物）。
- 不审核/替换字体版权（按用户提供的 `字体.zip` 原样打包）。
- 「分辨率(1K/2K/4K)」下拉框目前是死 UI（`_call_api` 从未读取）；上游 image-edit 模型原生分辨率有限（通常 1024/1536 量级），超过原生分辨率应走既有的「高清修复」工具。本任务仅在 design 里给出处理建议，**不强制实现**，除非 review 时用户要求。

## Assumptions

- **A1** 上游 image-edit 模型支持 OpenAI 标准 `size` 值（`1024x1024` / `1024x1536` / `1536x1024` / `auto`），不支持任意像素值。需在实现阶段实测确认（见 implement 验证步骤）。
- **A2** 插件运行时 cwd = 插件安装目录，`os.path.dirname(__file__)` 与 `resource_path` 回退都能定位到插件根的资源文件（与既有 `app.ico` 加载、`resource_path` 写法一致）。
- **A3** 桌面壳安装 `.lfplugin` 时会把 ZIP 内全部文件释放到插件目录（loose files），无需手动解压字体包；资源以扁平/子目录文件形式随包分发即可。
