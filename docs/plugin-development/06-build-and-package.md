# 构建与打包

只能使用 SDK CLI 生成 `.lfplugin` v4 制品：

```powershell
pnpm -C packages/plugin-sdk exec lingfang-plugin build <绝对插件目录> --out <绝对输出文件>
```

构建器会：

- 校验 manifest、入口文件和根级 README；
- 写入 `_meta.json`，其中 `formatVersion` 为 4；
- 排除 `data`、`.git`、`.venv`、`node_modules`、缓存和 Python 字节码；
- 固定 ZIP 时间戳、权限和排序，得到确定性 SHA-256；
- 执行文件数、单文件大小、总大小和路径安全检查。

不要用 `Compress-Archive`、Python `zipfile` 或其他手工 ZIP。缺少 `_meta.json` 的压缩包会被桌面安装器拒绝。
