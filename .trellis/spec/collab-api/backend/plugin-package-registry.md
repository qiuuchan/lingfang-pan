# Plugin Package Registry v4

## Scenario: Immutable Plugin Artifacts

### 1. Scope / Trigger

- 修改插件发布、团队库、市场、审核、购买、下载或制品清理时适用。
- 远端只拥有 package/release/catalog/entitlement，不拥有设备安装状态。

### 2. Signatures

- `POST /api/plugin-registry/releases`：raw `.lfplugin` v4 stream。
- `GET /api/plugin-registry/team|marketplace`：远端目录。
- `GET /api/plugin-packages/:id`：包与不可变版本历史。
- `GET /api/plugin-releases/:id/artifact`：鉴权下载或 S3 redirect。
- `POST /api/plugin-releases/:id/submit-marketplace`：按 release 提审。
- `POST /api/plugin-packages/:id/runtime-access|purchase`：团队授权检查/购买。
- DB unique：`PluginPackage(ownerTeamId, manifestId)`、`PluginRelease(packageId, version)`、`PluginEntitlement(teamId, packageId)`。

### 3. Contracts

- 上传格式固定为 ZIP：`_meta.json` 的 `formatVersion=4`、`manifest.json` 和源文件。
- 服务端流式落临时文件并计算最终 ZIP SHA-256；数据库只保存 manifest、文件清单、artifactKey、SHA 和大小。
- `PLUGIN_ARTIFACT_DRIVER=filesystem|s3`；filesystem 默认，S3 使用 endpoint/region/bucket/credentials/path-style 配置。
- 团队版本允许 prerelease；市场版本必须是正式严格 SemVer。团队目录最新版按 SemVer precedence 选取，不按创建时间。
- 市场审核更新 listing 的 `currentReleaseId`；新版本不会继承旧版本审核结果。
- 包详情对 owner team 返回全部 release；市场消费者（含已购 entitlement）只能看到并下载 `marketReviewStatus=APPROVED` 的具体 release。制品下载必须在 package 访问校验后再次校验 release 审核状态，delist 不影响已购团队下载历史 approved release。
- ZIP 校验必须把每个条目按边界流式消费到 EOF，并核对实际解压大小和 CRC-32；不能只读取 `_meta.json`/`manifest.json` 后信任其他条目的中央目录声明。

### 4. Validation & Error Matrix

- ZIP 超过 300MiB、解压总量超过 300MiB、文件超过 1500、单文件超过 60MiB -> `bad_request`。
- 重复/绝对/父级路径、符号链接、加密条目、ZIP64、非法压缩、缺少 v4 metadata/entry -> `bad_request`。
- 反斜杠路径，或任意深度出现 `data/.git/.venv/venv/node_modules/.lingfang/__pycache__` 段 -> `bad_request`。
- 实际解压超过声明大小、未到声明大小即 EOF、CRC 不符或 deflate 流损坏 -> `bad_request`，不得创建 release 或永久制品。
- 同 package+version -> `conflict`，不可覆盖。
- 团队成员/grant 拒绝 -> `forbidden`；付费市场无 entitlement -> `payment_required`。
- prerelease 提交市场 -> `bad_request`；非 PENDING release 审核 -> `conflict`。

### 5. Good/Base/Bad Cases

- Good：发布 `1.2.0` 后再发布 `1.1.9`，团队目录仍返回 `1.2.0`。
- Base：免费市场插件无需 entitlement 即可下载；付费插件购买后生成团队 entitlement。
- Bad：更新一行 `Plugin` 覆盖当前版本，或让市场目录返回设备安装状态。

### 6. Tests Required

- ZIP 路径/数量/大小/bomb/manifest/SHA 验证；覆盖伪造解压大小、错误 CRC、反斜杠和嵌套缓存段；filesystem 与 S3 adapter。
- SemVer 排序、重复版本、团队 grant、购买事务、逐版本 approve/reject/delist。
- package detail 与 artifact download 都要回归未审核 release 不可被 marketplace entitlement 绕过；owner team 仍可查看全部 release。
- legacy migration dry-run/apply 重跑不重复 review/audit，并能补齐已存在 release 的 entitlement/grant。

### 7. Wrong vs Correct

Wrong：按 `createdAt` 当作最新版，并覆盖旧制品。

Correct：创建不可变 `PluginRelease`，catalog 按 SemVer 或审核通过的 `currentReleaseId` 投影。
