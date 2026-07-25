# 发布与审核

发布工作区时 CLI 会先构建，再把原始 `.lfplugin` 二进制上传到 v4 注册中心：

```powershell
pnpm -C packages/plugin-sdk exec lingfang-plugin publish <插件目录> `
  --base http://localhost:19006 `
  --token <JWT> `
  --source-kind EXTERNAL_TOOL `
  --source-label "本地开发"
```

也可设置 `LINGFANG_API_BASE` 和 `LINGFANG_TOKEN`。发布到已有包时传 `--package-id`。服务端入口是 `POST /api/plugin-registry/releases`，请求体是 `application/octet-stream`，来源信息通过 `x-plugin-*` headers 传递。

发布成功只表示生成了不可变 release。进入市场还需要提交审核，平台审核员通过后，v4 listing 才能指向该 release。
