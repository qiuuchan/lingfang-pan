# 技术设计 — detail-poster 修复与资源补全

## 边界

本任务改动范围：

| 改 | 文件 | 说明 |
|---|---|---|
| 插件源码 | `plugins/detail-poster/main.py` | 比例绑定、size 映射、字体加载、（必要时）裁剪 |
| 插件源码 | `plugins/outfit-batch/main.py` | 仅确认图标加载，无源码改动（`favicon (4).ico` 放进去即可生效） |
| 资源 | `plugins/detail-poster/app.ico`、`plugins/detail-poster/fonts/*` | 新增 |
| 资源 | `plugins/outfit-batch/favicon (4).ico` | 新增 |
| 元数据 | 两插件 `manifest.json` | version 递增 |
| 产物 | `plugins/*.lfplugin` | 重新 `lingfang-plugin build` |

**不动**：`plugin_llm_bridge.rs`、`relay.service.ts`/`forwarders.ts`、`plugin-ai-policy.ts`、桌面壳解包逻辑。

## 数据流（生图尺寸链路）

```
[size 下拉框] ──(trace 绑定)──> mod.size_ratio
                                          │
gen_single/gen_main ─> _call_api(mod, target_size?)
                          │
                          │  ratio → STANDARD_SIZE (1024x1024 / 1024x1536 / 1536x1024)
                          ▼
               bridge_image_edit(prompt, [img], tier, n, size=STANDARD_SIZE)
                          │
                          ▼  (plugin_llm_bridge.rs route_image_edit → multipart size 字段)
               relay forwardRawPassthrough → 上游 /v1/images/edits
                          │
                          ▼  返回图片（上游原生分辨率，比例≈STANDARD_SIZE）
               [可选] Pillow center-crop 到目标精确比例
                          │
                          ▼
               存盘 + 预览
```

## 设计决策

### D1 尺寸：标准值 + 客户端裁剪（核心）

**问题**：上游不认 `1254x1254` 这类自定义值。即便映射到标准值，上游原生比例可能只到 2:3（1024x1536），没有真正的 3:4。

**方案（两层）**：
1. **请求层**：把 `size_map` 全部改为上游标准值，按目标比例选最近的上游尺寸：
   - `1:1` → `1024x1024`
   - `3:4` → `1024x1536`（上游无 3:4，取最接近的竖图；下一步裁剪到精确 3:4）
   - `2:3` → `1024x1536`
   - `9:16` → `1024x1536`（最接近的竖图；9:16 比 2:3 更瘦，裁剪时多切左右）
2. **修正层**：上游返回后，用 Pillow `ImageOps.fit`（center-crop）裁到目标比例的精确像素，保证「选什么出什么」：
   - `1:1` → 1024×1024（本就一致，无需裁）
   - `3:4` → 1024×1365（从 1024×1536 上下各裁掉一点 → 实际 3:4 是宽:高=3:4，高>宽，1024宽对应高≈1366）

   > 注：3:4 即 W:H=3:4，竖图。1024 宽 → 高 = 1024×4/3 ≈ 1366。从 1536 高里 center-crop 出 1366。
   - `2:3` → 1024×1536（本就一致，无需裁）

**新增辅助函数** `_crop_to_ratio(img, ratio)`：返回按比例 center-crop 后的 PIL Image。统一用在 `_call_api` 落盘前（单张）和 `_gen_main_task`（主图，可选，因主图本就用标准值）。

**为什么不在请求层就用精确像素**：上游会忽略/报错（已验证现象）。客户端裁剪是最稳的、与上游无关的保证。

**取舍**：center-crop 会切掉边缘内容。对电商主图通常可接受（主体居中）。若后续要避免切图，可改用「outpaint 扩边」但成本高，不在本任务范围。

### D2 单张生图 combobox 绑定

在 `create_module_widget` 创建 `size` combobox 后，加 `trace_add('write', ...)` 把选中值写回 `mod.size_ratio`（参考 `mode_var` 的既有写法，main.py:1127-1135）。`res`（分辨率）combobox 暂不接入（见 Out of Scope）。

### D3 一键主图三尺寸

`_gen_main_task` 的 `size_configs` 改为驱动「目标比例」而非自定义像素前缀。三个比例各调一次 `_call_api`，每次传该比例对应的 `STANDARD_SIZE`，结果再走 D1 的 `_crop_to_ratio`。文件名前缀保持区分（如 `1440-` / `1920-` / `2160-` 命名保留以兼容已存量文件编号逻辑，或改为 `1x1-`/`3x4-`/`2x3-`，二选一，倾向后者更直观）。

「只出 2 张」的修复：根因是某一档自定义 size 让上游报错→`_call_api` 返回 None。改用标准 size 后三档都会成功。

### D4 颜色图字体加载

**问题**：`BUILTIN_FONTS = {}` 空；`_find_font_file` 找不到任何字体→fallback `load_default`→中文不可见。

**方案**：
1. 新增 `plugins/detail-poster/fonts/` 目录，放入 `字体.zip` 解压后的全部 `.ttf/.otf`。
2. 启动时扫描该目录，按「文件名去扩展名」建 `BUILTIN_FONTS` 字典（如 `白无常可可体常规` → `fonts/白无常可可体常规_mianfeiziti.com.ttf`）。注意 `字体.zip` 里文件名带 `_mianfeiziti.com` 后缀和空格，需建立**显示名→文件名**映射；显示名取去掉 `_mianfeiziti.com` 后缀的部分，或维护一份精简别名表（至少覆盖默认的「白无常可可体常规」）。
3. `_find_font_file` 现有逻辑（先查 `BUILTIN_FONTS`，再查 `imported_fonts`）即可命中。系统字体走 tkinter 渲染（颜色图用 PIL 绘制，系统字体若 PIL 找不到文件则 fallback，保持现状）。
4. 颜色图字体下拉框的 `values` 已包含 `builtin_names = list(BUILTIN_FONTS.keys())`（main.py:2548），填充后自动出现。
5. 反推提示词的字体选择（main.py:758-762）只是把字体名作为文本传给 LLM，不需要字体文件，无需改。

**字体目录定位**：`os.path.join(os.path.dirname(__file__), "fonts")`，与 `app.ico` 加载方式一致（main.py:132），不依赖 cwd。

**显示名映射（最小别名表，确保默认字体可用）**：
```
白无常可可体常规 → 白无常可可体常规_mianfeiziti.com.ttf
白无常可可体粗   → 白无常可可体粗_mianfeiziti.com.ttf
思源黑体CN-Medium → 思源黑体CN-Medium_mianfeiziti.com.otf
...（其余按文件名 stem 自动建表）
```
扫描时：对每个字体文件，stem 去掉 `_mianfeiziti.com` 后缀作为显示名；同时保留原始 stem 作为别名，两者都指向同一文件。

### D5 资源打包布局

```
plugins/detail-poster/
  main.py
  manifest.json (0.2.4)
  README.md
  requirements.txt
  app.ico                 ← 新增（来自 app.zip）
  fonts/                  ← 新增（来自 字体.zip 解压）
    白无常可可体常规_mianfeiziti.com.ttf
    ...（25 个）

plugins/outfit-batch/
  main.py
  manifest.json (递增)
  ...
  favicon (4).ico         ← 新增（来自 favicon (4).zip）
```

`packWorkspace` 自动递归打包（archive.ts:132-218），排除段不含 `fonts`，故字体随包。`app.ico`/`favicon (4).ico` 在根目录也被打包。

**体积核算**：字体未压缩 ~188MB → DEFLATE 后 `.lfplugin` 约 110–130MB（OTF/TTF 已压缩，DEFLATE 收益有限）。单文件最大 ~21MB < 60MB；总 < 300MB；文件数 ~30 < 1500。均合规。

### D6 图标加载（已就绪，仅缺资源）

- detail-poster `main.py:132-135` 已 `iconbitmap(default=_icon)` 加载同目录 `app.ico`，try/except 静默。放入 `app.ico` 即生效。
- outfit-batch `main.py:560/1183/2003` 用 `resource_path("favicon.ico") or "favicon (4).ico"`，`resource_path` 回退 cwd=插件目录。放入 `favicon (4).ico` 即生效。

## 兼容性 / 回归

- `mod.size_ratio` 绑定后，`load_state` 读取旧状态 `size_ratio` 仍兼容（默认 1:1）。
- `_call_api` 的 `target_size` 参数语义从「自定义像素」变为「标准 size 字符串」；调用方 `_gen_main_task`/`_gen_mode_batch` 同步改。
- 既有「设计→修改主图尺寸」工具（`_do_resize_main`，main.py:677）用 Pillow resize，不受影响。
- 字体目录不存在时（老版本插件目录无 fonts/），`BUILTIN_FONTS` 保持空，颜色图 fallback 行为同现状——不崩。

## 验证策略

1. **尺寸实测（关键）**：实现后用 fast 档实跑单张 1:1 / 2:3，用 `Image.open(path).size` 验证返回图实际宽高比例。若上游连标准 size 都不认，降级为「请求 auto + 客户端 center-crop 到目标比例」。
2. **主图三张**：实跑一键主图，确认 3 个文件落盘且比例正确。
3. **颜色图中文**：输入「测试中文」，生成预览肉眼确认可见。
4. **AI 政策扫描**：用 `plugin-ai-policy.ts` 的 `checkPluginAiPolicy` 或桌面预览面板验证 `ok:true`。
5. **打包**：`unzip -l` 确认资源在包内。

## 风险

- **R1 上游 size 支持范围未知**：D1 的请求层标准值是假设（A1）。验证步骤 1 若证伪，切到「auto + 裁剪」降级方案，不影响交付（裁剪层本来就在）。
- **R2 包体大**：130MB 量级 `.lfplugin` 分发/安装较慢。用户已选方案 B（全量），可接受。后续若要瘦身，改回方案 A（只内置默认字体 + 导入 UI）。
- **R3 字体文件名带空格/中文**：PIL `ImageFont.truetype` 接受任意路径，OK；ZIP 打包器 `normalizeRelative` 只禁反斜杠和 `..`，中文/空格路径合法。
