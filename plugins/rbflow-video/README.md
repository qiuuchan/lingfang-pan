# 动作迁移视频生成（RBFLow 插件）

灵坊平台插件，封装 RunningHub `WanAnimateToVideo` 动作迁移工作流：上传参考图片 + 参考视频 → 生成「把视频动作迁移到图片人物」的成品视频。

## 功能

- **多素材笛卡尔积**：N 张图 × M 个视频 = N×M 个任务，一次提交批量生成
- **按视频时长计费**：经平台桥按「灵石/秒」扣费（PER_SECOND，单价见平台价目表，默认 0.5 灵石/秒）
- **实时进度**：SSE 进度推送，右栏卡片实时更新
- **任务队列**：拖拽排序、状态筛选（全部/等待/执行中/完成/失败）、统计、批量删除、自动重试
- **自定义输出文件夹**：支持按「日期/图片分类」自动建子目录，另存为
- **现代深色 UI**（PySide6 / Qt6）

## 安全模型（防绕过计费）

本插件**不持有任何 RBFLow / RunningHub 凭证**。视频生成经平台桥 `/video/generate` 代理转发到平台运营的 RBFLow 实例：

1. 插件调用桥 `/video/generate`（带 image+video+seconds）
2. 桥转发到 relay `videoGenerations`，**先按秒扣灵石**（reserve→reconcile 两阶段）
3. 计费成功后，relay 读取后台管理的 RBFLow 凭证，转发到 RBFLow `POST /api/v1/tasks`
4. 转发失败则自动退款（relay `refundVideo`，凭 `call_log_id`，幂等）

插件进程 env 仅有 `LINGFANG_PLUGIN_BRIDGE_URL` / `LINGFANG_PLUGIN_BRIDGE_TOKEN`（桌面注入），**不含** RBFLow 地址或密钥。RBFLow 凭证由**平台管理员在后台管理「设置 → 视频」配置**（PlatformSetting 表）。用户物理上无法绕过灵石计费直连 RBFLow。

### 后台配置（管理员）

在灵坊后台管理「设置 → 视频」标签页配置：

- **RBFLow 服务地址**：平台运营的 RBFLow 实例 URL（含端口，如 `http://rbflow.internal:41792`）
- **RBFLow API-KEY**：对应 RBFLow 实例 `.env` 的 `API_KEY`（密钥脱敏，可用 reveal-secret 查看明文）
- **测试连通**：探测 RBFLow `/api/v1/health` 校验服务存活

未配置时视频插件报「RBFLow 服务未配置」。

## 使用

在灵坊桌面端安装本插件后启动。界面三栏：

| 栏 | 用途 |
| --- | --- |
| **左 · 图片素材** | 选图/选文件夹、分类、多选缩略图、全选/反选/删除/移动 |
| **中 · 参考视频** | 上传视频、分类、多选、工作流节点配置（默认 78/image、77/video） |
| **右 · 任务队列** | 统计、状态筛选、输出目录、任务卡片、批量操作、自动重试 |

1. 左栏选图片，中栏选参考视频
2. 顶部确认档位（fast/premium）
3. 点「🚀 提交生成」，确认预计灵石消耗
4. 右栏查看进度，完成后视频自动保存到输出目录

## 输出命名

```
{输出目录}/{日期}/{图片分类}/{图片名}_{视频名}.mp4
例：outputs/2026-7-23/默认/模特_舞蹈.mp4
```

同名文件不会被覆盖：若目标名已存在，自动追加递增后缀 `_1`、`_2`……
（如 `模特_舞蹈.mp4` → `模特_舞蹈_1.mp4` → `模特_舞蹈_2.mp4`），保留此前输出的所有视频。

## 依赖

- PySide6 ≥ 6.7（Qt6）
- requests、Pillow、ffmpeg-python（视频时长探测，需系统 ffprobe）

## 计费配置

视频单价在平台管理端「价目表」配置（capability=`video`、model=`video_generate`、unit=`PER_SECOND`）。seed 默认 0.5 灵石/秒，管理员可调整。
