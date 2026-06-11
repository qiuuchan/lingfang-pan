# LingFang M0/M3 本地验证脚本（PowerShell）。
#
# 前置：
#   1) pnpm db:up                     # 起本地 PostgreSQL
#   2) 复制 .env.example 为 .env 并设置 DATABASE_URL 等
#   3) cargo run -p server            # 另开一个终端，启动服务端（监听 127.0.0.1:8787）
#   4) 运行本脚本：  pwsh tools/verify.ps1
#
# 覆盖：注册 → 登录 → 建租户 → 成员可见（M0 多租户闭环，不依赖 LLM）。
# 插件生成/发布闭环需先配置真实第三方 LLM 网关 key，见脚本末尾注释。

$ErrorActionPreference = 'Stop'
$base = $env:LINGFANG_API ; if (-not $base) { $base = 'http://127.0.0.1:8787' }

function Api($method, $path, $body, $token) {
  $headers = @{}
  if ($token) { $headers['Authorization'] = "Bearer $token" }
  $json = if ($null -ne $body) { $body | ConvertTo-Json -Depth 10 } else { $null }
  return Invoke-RestMethod -Method $method -Uri "$base$path" -Headers $headers -ContentType 'application/json' -Body $json
}

Write-Output "== 健康检查 =="
$h = Api GET '/health' $null $null
if ($h.status -ne 'ok') { throw "健康检查失败" }

$email = "u$(Get-Random)@lingfang.local"
Write-Output "== 注册 / 登录（$email）=="
Api POST '/auth/register' @{ email = $email; password = 'password123'; display_name = '验证用户' } $null | Out-Null
$login = Api POST '/auth/login' @{ email = $email; password = 'password123' } $null
if (-not $login.token) { throw "登录未返回 token" }

Write-Output "== 建租户 =="
$t = Api POST '/tenants' @{ name = 'Acme'; slug = "acme$(Get-Random)" } $login.token
if ($t.role -ne 'owner') { throw "创建者应为 owner" }

Write-Output "== 成员可见 =="
$members = Api GET '/members' $null $t.token
if ($members.members.Count -lt 1) { throw "至少应有创建者一名成员" }

Write-Output ""
Write-Output "M0 多租户闭环通过 [OK]：注册 -> 登录 -> 建租户 -> 成员可见"
Write-Output ""
Write-Output "下一步（需真实第三方 LLM key 才能验证 M1/M3 生成发布闭环）："
Write-Output "  Api POST '/llm-bindings' @{ name='nb'; base_url='https://<newapi>/v1'; api_key='sk-...'; models=@('gpt-4o-mini') } \$t.token"
Write-Output "  \$d  = Api POST '/drafts'            @{ prompt='做一个待办清单插件' } \$t.token"
Write-Output "  \$d2 = Api POST \"/drafts/\$(\$d.id)/generate\" @{ prompt='做一个待办清单插件' } \$t.token"
Write-Output "  Api POST \"/drafts/\$(\$d2.id)/publish\" \$null \$t.token"
