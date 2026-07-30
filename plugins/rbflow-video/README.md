# RBFLow 创意工坊（灵坊平台插件）

灵坊平台插件，封装平台运营的 RBFLow 实例上的两类 RunningHub 工作流。**顶部 Tab 一键切换**：

| Tab | 工作流 | 输入 | 输出 | 计费 |
| --- | --- | --- | --- | --- |
| 🎬 视频 · 动作迁移 | `WanAnimateToVideo` | 参考图片 + 参考视频 | 把视频动作迁移到图片人物的成品视频 | 按参考视频时长（秒）`PER_SECOND` |
| 🎙 音频 · 声音克隆 | 声音克隆工作流 | 参考音频 + 目标文本 | 用参考音色朗读目标文本的克隆语音 | 按输出音频估算秒数 `PER_SECOND` |

## 功能

- **双工作流顶部 Tab 切换**：视频 / 音频共用同一个任务队列、输出目录、主题与档位设置
- **视频 · 多素材笛卡尔积**：N 张图 × M 个视频 = N×M 个任务，一次提交批量生成
- **音频 · 声音克隆**：选 1 个参考音频 + 输入目标文本，生成克隆语音（FLAC）
- **按秒计费**：经平台桥按「灵石/秒」扣费
  - 视频秒数 = 插件 ffprobe 探测参考视频时长（信任 + 审计）
  - 音频秒数 = 平台 relay 由目标文本长度估算（中文语速启发式，约 4 字/秒，向上取整 ≥1 秒）；插件用**同一公式**做提交前预估，故「预估即实扣」，且插件无法篡改计费秒数
- **实时进度**：短轮询进度推送，任务卡片实时更新（视频/音频共用 RBFLow 任务状态机）
- **任务队列**：拖拽排序、状态筛选（全部/等待/执行中/完成/失败）、统计、批量删除、自动重试
- **自定义输出文件夹**：
  - 视频：`{输出目录}/{日期}/{图片分类}/{图片名}_{视频名}.mp4`
  - 音频：`{输出目录}/{日期}/voice/{音频名}.flac`
- **现代深色 UI**（PySide6 / Qt6），支持深色/亮色主题

## 安全模型（防绕过计费）

本插件**不持有任何 RBFLow / RunningHub 凭证**。所有生成经平台桥代理转发到平台运营的 RBFLow 实例：

1. 插件调用桥
   - 视频：`POST /video/generate`（image + video + seconds）
   - 音频：`POST /audio/generate`（audio + prompt_text；**不传 seconds**，由 relay 估算）
2. 桥转发到 relay（视频 `videoGenerations` / 音频 `audioGenerations`），**先按秒扣灵石**（reserve→reconcile 两阶段）
3. 计费成功后，relay 读取后台管理的 RBFLow 凭证，转发到 RBFLow
   - 视频：`POST /api/v1/tasks`
   - 音频：`POST /api/v1/tasks/voice`
4. 转发失败则自动退款（relay `refundVideo` / `refundAudio`，凭 `call_log_id`，幂等）

进度与下载经桥 `/video/stream`、`/video/download`（音频为 `/audio/stream`、`/audio/download`）代理，注入平台凭证查询/拉取 RBFLow 任务，插件进程拿不到凭证。

插件进程 env 仅有 `LINGFANG_PLUGIN_BRIDGE_URL` / `LINGFANG_PLUGIN_BRIDGE_TOKEN`（桌面注入），**不含** RBFLow 地址或密钥。RBFLow 凭证由**平台管理员在后台管理「设置 → 视频」配置**（PlatformSetting 表）。用户物理上无法绕过灵石计费直连 RBFLow。

### 后台配置（管理员）

在灵坊后台管理「设置 → 视频」标签页配置：

- **RBFLow 服务地址**：平台运营的 RBFLow 实例 URL（含端口，如 `http://rbflow.internal:41792`）
- **RBFLow API-KEY**：对应 RBFLow 实例 `.env` 的 `API_KEY`（密钥脱敏，可用 reveal-secret 查看明文）
- **测试连通**：探测 RBFLow `/api/v1/health` 校验服务存活

音频工作流还需在 RBFLow 实例 `.env` 配置 `VOICE_WORKFLOW_ID` 等（见 RBFLow `.env.example`）；未配置时 RBFLow `/tasks/voice` 返回 503，插件会提示「声音克隆工作流未配置」。

未配置 RBFLow 地址时插件报「RBFLow 服务未配置」。

## 使用

在灵坊桌面端安装本插件后启动。顶部 Tab 选择工作流：

### 🎬 视频 · 动作迁移

界面三栏：

| 栏 | 用途 |
| --- | --- |
| **左 · 图片素材** | 选图/选文件夹、分类、多选缩略图、全选/反选/删除/移动 |
| **中 · 参考视频** | 上传视频、分类、多选、工作流节点配置（默认 78/image、77/video） |
| **右 · 任务队列** | 统计、状态筛选、输出目录、任务卡片、批量操作、自动重试 |

1. 左栏选图片，中栏选参考视频
2. 顶部确认档位（fast/premium）
3. 点「🚀 提交生成」，确认预计灵石消耗
4. 右栏查看进度，完成后视频自动保存到输出目录

### 🎙 音频 · 声音克隆

界面三栏：

| 栏 | 用途 |
| --- | --- |
| **左 · 参考音频** | 上传/拖放参考音频（mp3/wav/flac/m4a/aac/ogg/opus），单选 |
| **中 · 目标文本** | 输入要让克隆语音说的文本，实时显示字数/预估秒数/预估灵石 |
| **右 · 任务队列** | 与视频工作流共享 |

1. 左栏选 1 个参考音频（决定克隆音色，建议清晰人声）
2. 中栏输入目标文本
3. 点「🚀 生成克隆语音」，确认预估灵石消耗
4. 右栏查看进度，完成后音频自动保存到 `{输出目录}/{日期}/voice/`

## 输出命名

```
视频：{输出目录}/{日期}/{图片分类}/{图片名}_{视频名}.mp4
      例：outputs/2026-7-23/默认/模特_舞蹈.mp4
音频：{输出目录}/{日期}/voice/{音频名}.flac
      例：outputs/2026-7-23/voice/参考.flac
```

同名文件不会被覆盖：若目标名已存在，自动追加递增后缀 `_1`、`_2`……
（如 `模特_舞蹈.mp4` → `模特_舞蹈_1.mp4`），保留此前输出的所有文件。

## 依赖

- PySide6 ≥ 6.7（Qt6）
- requests、Pillow、ffmpeg-python（视频时长探测，需系统 ffprobe；音频秒数由文本估算，无需探测）

## 计费配置

单价在平台管理端「价目表」配置：

- 视频：capability=`video`、model=`video_generate`、unit=`PER_SECOND`（seed 默认 0.5 灵石/秒）
- 音频：capability=`audio`、model=`voice_clone`、unit=`PER_SECOND`（seed 默认 0.5 灵石/秒）

管理员可调整。音频计费秒数由 relay 按目标文本估算（`VOICE_CHARS_PER_SECOND`，默认 4 字/秒）；
如需调整语速假设，须**同时**修改 relay `relay.service.ts` 与插件 `main.py` 中的同名常量，保持「预估即实扣」。

## 版本

- **0.4.0**：新增音频声音克隆工作流 + 顶部 Tab 切换；插件更名为「RBFLow 创意工坊」；新增 `audio.generate` 能力。
- **0.3.x**：视频动作迁移（按秒计费、任务队列、自定义输出）。
