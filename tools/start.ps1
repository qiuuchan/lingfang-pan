# LingFang 一键启动脚本（Windows / PowerShell）。
#
# 流程：检查依赖 → 校验 collab-api 配置 → 确保 PostgreSQL 可连 → 迁移+建管理员 →
#       启动 collab-api（NestJS，:3000）→ 等待健康 → 启动桌面壳（Tauri）。
#
# 后端为 apps/collab-api（NestJS，/api/* 前缀，依赖 PostgreSQL 16+）。
# 旧 Rust apps/server（:8787）已下线，不再启动——见 docs/collab-platform.md「双后端收敛」。
#
# 用法：  pnpm start        （见根 package.json）
#   或    pwsh tools/start.ps1
#
# 可选参数：
#   -SkipDesktop   只起后端（collab-api），不起桌面壳

param(
  [switch]$SkipDesktop
)

$ErrorActionPreference = 'Stop'
# 仓库根 = 本脚本所在目录的上一级。
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Info($msg) { Write-Host "[LingFang] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "[LingFang] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[LingFang] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "[LingFang] $msg" -ForegroundColor Red; exit 1 }

# ---------- 0. 依赖检查 ----------
Info "检查工具链…"
foreach ($t in @('pnpm')) {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { Die "缺少 $t，请先安装。" }
}

# ---------- 1. 校验 collab-api .env ----------
$collabDir = Join-Path $Root 'apps/collab-api'
$envPath = Join-Path $collabDir '.env'
if (-not (Test-Path $envPath)) {
  Info "未找到 apps/collab-api/.env，从 .env.example 复制…"
  Copy-Item (Join-Path $collabDir '.env.example') $envPath
  Warn "已生成 apps/collab-api/.env，使用默认开发配置。如需自定义请编辑：$envPath"
}

# 从 .env 读取 DATABASE_URL 与 PORT（简易解析，不引入 dotenv）。
function Get-EnvVar($file, $key) {
  $line = Get-Content $file | Where-Object { $_ -match "^$key\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  $val = ($line -split '=', 2)[1].Trim()
  # 去掉两端引号。
  if ($val -match '^".*"$') { $val = $val.Substring(1, $val.Length - 2) }
  return $val
}

$databaseUrl = Get-EnvVar $envPath 'DATABASE_URL'
if (-not $databaseUrl) { Die "apps/collab-api/.env 缺少 DATABASE_URL，请检查配置。" }
$port = Get-EnvVar $envPath 'PORT'
if (-not $port) { $port = '3000' }

# ---------- 2. 检查端口未被占用 ----------
$portBusy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($portBusy) {
  Die "端口 $port 已被占用（PID $($portBusy.OwningProcess -join ',')）。请先停止占用该端口的进程，或修改 .env 的 PORT。"
}

# ---------- 3. 检查 PostgreSQL 连通性（原生 PG） ----------
# collab-api 依赖 lingfang/lingfang@localhost:5432/lingfang_collab（见 docs/collab-deployment.md）。
# 找 psql.exe（原生 PG 安装路径）；collab-api 用 Prisma，不受 PG locale 影响。
$psql = $null
foreach ($ver in @('18','17','16','15')) {
  $cand = "C:\Program Files\PostgreSQL\$ver\bin\psql.exe"
  if (Test-Path $cand) { $psql = $cand; break }
}

if ($psql) {
  Info "检查 PostgreSQL 连通性（lingfang@localhost:5432/lingfang_collab）…"
  $env:PGPASSWORD = 'lingfang'
  $connTest = & $psql -h localhost -p 5432 -U lingfang -d lingfang_collab -tAc "SELECT 1;" 2>&1
  $connOk = $LASTEXITCODE -eq 0
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  if (-not $connOk) {
    Warn "无法以 lingfang 身份连接 lingfang_collab 库。"
    Write-Host $connTest -ForegroundColor DarkGray
    Die "数据库未就绪。请先以超级用户执行建库（参考命令）：
  psql -U postgres -d postgres -c `"CREATE USER lingfang WITH PASSWORD 'lingfang';`"
  psql -U postgres -d postgres -c `"CREATE DATABASE lingfang_collab OWNER lingfang LOCALE 'C' TEMPLATE template0;`"
完成后重新运行 pnpm start。详见 docs/collab-deployment.md。"
  }
  Ok "PostgreSQL 连通正常。"
} else {
  Warn "未找到 psql.exe，跳过连通性预检（将依赖 prisma 自身的连接错误报告）。"
}

# ---------- 4. 迁移 + 建平台管理员 ----------
Info "应用 Prisma 迁移 + 生成客户端…"
& pnpm -C $collabDir prisma:deploy 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { Die "Prisma 迁移失败。请检查 DATABASE_URL 与 PostgreSQL 状态。" }

Info "生成平台管理员（幂等，按 .env 的 PLATFORM_ADMIN_EMAIL）…"
& pnpm -C $collabDir seed:admin 2>&1 | ForEach-Object { Write-Host $_ }

# ---------- 5. 启动 collab-api ----------
Info "启动 collab-api（NestJS，监听 :$port）…"
$logDir = Join-Path $Root 'night_runs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$serverLog = Join-Path $logDir 'collab-api.log'
# Windows 上 pnpm 是 .cmd 脚本（非 .exe），Start-Process 直接用 'pnpm' 会报「不是有效的 Win32 应用程序」。
# 用 pwsh 子进程包装，既拿到可追踪的进程对象，又能正确重定向输出。
$serverProc = Start-Process -FilePath 'pwsh' -ArgumentList '-NoProfile', '-Command', "pnpm -C `"$collabDir`" dev" `
  -WorkingDirectory $Root -PassThru -NoNewWindow `
  -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $logDir 'collab-api.err.log')

# ---------- 6. 等待 collab-api 健康 ----------
$healthUrl = "http://localhost:$port/api/health"
Info "等待 collab-api 健康（$healthUrl）…"
$up = $false
foreach ($i in 1..60) {
  if ($serverProc.HasExited) { Die "collab-api 进程已退出（退出码 $($serverProc.ExitCode)）。查看日志：$serverLog" }
  try {
    $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 -ErrorAction Stop
    if ($resp.status -eq 'ok') { $up = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $up) { Die "collab-api 在 120 秒内未就绪。查看日志：$serverLog" }
Ok "collab-api 已就绪：http://localhost:$port（Swagger: http://localhost:$port/api/docs）"

# ---------- 7. 启动桌面壳 ----------
if ($SkipDesktop) {
  Ok "后端已启动（-SkipDesktop）。日志：$serverLog"
  Info "停止：结束 pnpm dev 进程树（PID $($serverProc.Id)）。"
  exit 0
}

Info "启动桌面壳（Tauri）…首次进入登录页，后端地址填 http://127.0.0.1:$port。"
try {
  pnpm -C apps/desktop dev
} finally {
  # 桌面壳关闭后，清理 collab-api 进程。
  Info "桌面壳已退出，停止 collab-api…"
  if (-not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue }
  Ok "已停止。"
}
