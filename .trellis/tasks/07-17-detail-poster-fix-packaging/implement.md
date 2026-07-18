# 执行计划 — detail-poster 修复与资源补全

## 前置准备

- [ ] P1 解压资源到临时位置备取：
  - `app.zip` → 取 `app.ico`
  - `字体.zip` → 取 `字体/` 下全部 `.ttf/.otf`（25 个）
  - `favicon (4).zip` → 取 `favicon (4).ico`
- [ ] P2 实测上游 size 支持（验证假设 A1，决定请求层策略）：用 curl 或临时脚本经桥 `/image/edit` 发 `size=1024x1024` 和 `size=1254x1254`，对比返回图实际像素与是否报错。**结论记录到本文件底部「实测记录」**。

> Review Gate 0：P2 结论决定 D1 请求层用「标准值」还是「auto」。若标准值被忽略，请求层改 `size=auto`（或不发 size），统一靠客户端裁剪。

## Step 1 — 放入资源文件

- [ ] 1.1 `plugins/detail-poster/app.ico` ← P1 的 app.ico
- [ ] 1.2 `plugins/detail-poster/fonts/` ← P1 的全部字体文件（扁平，保留原文件名含 `_mianfeiziti.com` 后缀）
- [ ] 1.3 `plugins/outfit-batch/favicon (4).ico` ← P1 的 favicon (4).ico
- [ ] 1.4 校验：`ls plugins/detail-poster/fonts/ | wc -l` ≈ 25；单文件 ≤ 60MB

## Step 2 — detail-poster 源码：尺寸修复（main.py）

- [ ] 2.1 新增模块级常量 `RATIO_STANDARD_SIZE`（ratio→上游标准 size 映射）与 `RATIO_PIXELS`（ratio→目标精确像素，用于裁剪）：
  - `1:1` → 标准 `1024x1024`，像素 `(1024,1024)`
  - `3:4` → 标准 `1024x1536`，像素 `(1024,1366)` （W:H=3:4）
  - `2:3` → 标准 `1024x1536`，像素 `(1024,1536)`
  - `9:16` → 标准 `1024x1536`，像素 `(768,1366)` 或 `(1024,1820)`（取与 1024x1536 最近且高<宽方向合理的；9:16 比 2:3 更瘦）
- [ ] 2.2 新增 `_crop_to_ratio(self, img, ratio)`：用 `ImageOps.fit(img, RATIO_PIXELS[ratio], Image.LANCZOS)` center-crop（`from PIL import ImageOps`）。
- [ ] 2.3 `create_module_widget`：`size` combobox 后加 `trace_add('write', ...)` 回写 `mod.size_ratio`（仿 `mode_var` main.py:1135）。
- [ ] 2.4 `_call_api`：
  - 把局部 `size_map`（自定义像素）替换为 `RATIO_STANDARD_SIZE` 查询；`target_size` 形参语义改为「标准 size 字符串」。
  - 落盘前对返回图做 `_crop_to_ratio(img, mod.size_ratio)`（`target_size` 透传时由调用方指定 ratio；新增可选形参 `ratio=None`，缺省取 `mod.size_ratio`）。
- [ ] 2.5 `_gen_main_task`：`size_configs` 改为 `[("1:1","1x1"),("3:4","3x4"),("2:3","2x3")]`（前缀改直观命名，或保留数字前缀——二选一，记录决定）；每次循环 `self._call_api(mod, target_size=RATIO_STANDARD_SIZE[ratio], ratio=ratio, custom_name=...)`。删掉局部 `size_map_api`。
- [ ] 2.6 `_gen_mode_batch`：`target_size="1254x1254"` 改为 `RATIO_STANDARD_SIZE["1:1"]`（换装换脸固定 1:1）。

> Review Gate 1：尺寸链路改完，跑 syntax 检查 `python -m py_compile plugins/detail-poster/main.py`。

## Step 3 — detail-poster 源码：字体加载（main.py）

- [ ] 3.1 新增 `_scan_builtin_fonts()`：扫描 `os.path.join(os.path.dirname(__file__),"fonts")` 下 `.ttf/.otf`，对每个文件：
  - `raw_stem = 文件名去扩展名`（如 `白无常可可体常规_mianfeiziti.com`）
  - `display = raw_stem` 去 `_mianfeiziti.com` 后缀（如 `白无常可可体常规`）
  - `BUILTIN_FONTS[display] = 相对/绝对路径`；同时 `BUILTIN_FONTS[raw_stem] = 路径`（别名兼容）
- [ ] 3.2 模块加载时调用 `_scan_builtin_fonts()`（放在 `BUILTIN_FONTS = {}` 定义之后，`bridge_ready` 之前）。
- [ ] 3.3 确认 `_find_font_file` 命中 `BUILTIN_FONTS`（现有逻辑即可，无需改）；颜色图下拉 `values` 已含 `builtin_names`。
- [ ] 3.4 字体目录缺失时不崩：`_scan_builtin_fonts` try/except，目录不存在直接 return。

> Review Gate 2：`python -m py_compile` 通过；`python -c "..."` 模拟扫描逻辑确认默认字体名能命中（目录存在时）。

## Step 4 — 元数据 + 产物

- [ ] 4.1 `plugins/detail-poster/manifest.json` version `0.2.3` → `0.2.4`。
- [ ] 4.2 `plugins/outfit-batch/manifest.json` version 递增。
- [ ] 4.3 detail-poster README「局限」段更新（字体已内置、尺寸说明）。
- [ ] 4.4 构建：
  ```
  pnpm -C packages/plugin-sdk exec lingfang-plugin build ../../plugins/detail-poster --out ../../plugins/detail-poster.lfplugin
  pnpm -C packages/plugin-sdk exec lingfang-plugin build ../../plugins/outfit-batch --out ../../plugins/outfit-batch.lfplugin
  ```
- [ ] 4.5 `unzip -l plugins/detail-poster.lfplugin | grep -E "app.ico|fonts/"` 确认资源在包；`unzip -l plugins/outfit-batch.lfplugin | grep "favicon"` 确认。

## Step 5 — 验证（实跑）

> 需在桌面壳内运行插件（桥环境变量）。若无桥环境，至少做完静态验证 + 打包验证，实跑部分标注「待用户在客户端验证」。

- [ ] 5.1 detail-poster 单张：选 1:1 生图 → `Image.open(path).size` 宽==高；选 2:3 → 高>宽且比≈1.5。
- [ ] 5.2 detail-poster 一键主图：3 文件落盘，比例分别为 1:1/3:4/2:3。
- [ ] 5.3 detail-poster 颜色图：中文输入 → 预览可见。
- [ ] 5.4 detail-poster 窗口图标显示；outfit-batch 窗口图标显示。
- [ ] 5.5 回归：反推提示词、换装换脸、拼长图、高清修复不受影响。
- [ ] 5.6 AI 政策扫描 `ok:true`（桌面预览面板或 `checkPluginAiPolicy`）。

## 回滚点

- 源码改动均在 `plugins/detail-poster/main.py` 单文件 + 两处 manifest version + 新增资源文件。
- 回滚：`git checkout plugins/detail-poster/main.py plugins/*/manifest.json` + 删新增资源 + 重 build。

## 实测记录（P2 填写）

未直接经桥测上游 size（需桌面壳桥运行时）。但**修正层（center-crop）使正确性独立于上游 size 行为**，已用 Pillow 对 4 种上游返回（1024x1024 / 1024x1536 / 1536x1024 横图 / 1024x1792）× 4 比例全组合验证，输出像素与目标精确匹配（1:1→1024×1024、3:4→1024×1366、9:16→864×1536、2:3→1024×1536），比例值 1.000/0.750/0.562/0.667 全 OK。

- 上游对自定义 `size`：据用户 bug 报告（1:1→横图）确认被忽略。
- 请求层策略 = **标准值**（`RATIO_STANDARD_SIZE`）。即便上游忽略，crop 兜底保证精确比例。
- 结论：无需 runtime 预测上游，crop 层已闭环。

## 完成状态

- [x] Step 1 资源放置（app.ico / 25 字体 / favicon (4).ico）
- [x] Step 2 尺寸修复（combobox 绑定 + 标准size + center-crop；py_compile 通过；crop 数学实测全 OK）
- [x] Step 3 字体扫描（`_scan_builtin_fonts`；默认字体命中验证通过）
- [x] Step 4 版本号 + 打包（detail-poster 0.2.4 109MB/31文件；outfit-batch 0.2.3 47KB/6文件；`unzip -l` 确认资源在内）
- [x] Step 5.6 AI 政策扫描：两插件 `ok:true`、零诊断
- [ ] Step 5.1–5.5 **待用户在桌面客户端实跑验证**（单张比例 / 一键主图3张 / 颜色图中文 / 窗口图标 / 回归）—— 需桥运行时，本会话无法执行
