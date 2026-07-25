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
