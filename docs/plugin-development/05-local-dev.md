# 本地开发

建议在仓库根目录安装依赖后运行 CLI：

```powershell
pnpm install
pnpm plugin:create demo --runtime python
pnpm plugin:validate .\demo
```

本地检查顺序：

1. 确认 `manifest.json`、根级 `README.md` 和入口文件存在。
2. 运行 `validate`，先修复 schema 和业务规则错误。
3. 对脚本运行时，在独立目录安装依赖，不把 `node_modules`、`.venv`、缓存或 `data/` 打进制品。
4. 在桌面端导入/预览，确认声明能力和实际调用一致。
5. 将持久状态写入宿主提供的 `data/`，不要污染不可变 release 目录。

`pnpm start` 会按 `apps/collab-api/.env` 的 `PORT` 启动后端，完成 Prisma 生成/部署和管理员 seed 后再启动 Tauri。
