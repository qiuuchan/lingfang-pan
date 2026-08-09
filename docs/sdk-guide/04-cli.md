# CLI 命令

CLI 名称是 `lingfang-plugin`，仓库根脚本提供等价快捷命令。

```powershell
# 创建：模板仅支持 client / nodejs / python
pnpm plugin:create demo --runtime client

# 校验
pnpm plugin:validate .\demo
pnpm -C packages/plugin-sdk exec lingfang-plugin validate .\demo --json

# 构建 v4 制品
pnpm plugin:build .\demo --out .\demo.lfplugin

# 发布工作区或现有制品
pnpm plugin:publish .\demo --base http://localhost:19006 --token <JWT>
```

`create` 支持 `--id`、`--author`、`--description`、`--visibility`、`--capabilities`、`--force`。`publish` 支持 `--package-id`、`--source-kind`、`--source-label`、`--client` 和 `--no-build`。

退出码 `0` 表示成功，`1` 表示输入、校验、构建、网络或服务端错误。

## adapt（适配检验改造）

把一份插件目录改造成平台合规制品，并产出适配报告。详细协议与错误码见
[适配检验改造](../plugin-development/10-adaptation.md)。

```powershell
# 静态校验（不改造、不确证）→ report.status = NOT_RUN
lingfang-plugin adapt .\my-plugin

# 确定性改造 + 重打包成 .lfplugin（不执行运行时确证）
lingfang-plugin adapt .\my-plugin --repack --out .\out

# 改造 + 执行运行时确证 + 重打包
lingfang-plugin adapt .\my-plugin --execute --repack --out .\out

# 机器可读 JSON 报告
lingfang-plugin adapt .\my-plugin --json
```

| 参数 | 作用 |
| --- | --- |
| `--execute` | 执行运行时确证（需本机有对应运行时） |
| `--repack` | 改造后重新打包成 `.lfplugin` |
| `--out <dir>` | 打包输出目录 |
| `--in-place` | **危险**：原地改造（默认拷贝到临时工作区） |
| `--json` | 输出 JSON 格式（供程序消费） |

退出码：`0` 改造通过；`1` 存在残留问题 / 确证失败 / 引擎错误。报告 `status` 枚举：
`NOT_RUN` / `ADAPTED_PASSED` / `NEEDS_HUMAN` / `ADAPTED_FAILED`。

