# LingFang 一键启动脚本（Windows / PowerShell）。
#
# 流程：检查依赖 → 准备 .env → 启动服务端（内嵌 SQLite，自动建库）→ 等待健康 → 启动桌面壳。
# 用法：  pnpm start        （见根 package.json）
#   或    pwsh tools/start.ps1
#
# 可选参数：
#   -SkipDesktop   只起后端（服务端），不起桌面壳

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
foreach ($t in @('cargo', 'pnpm')) {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { Die "缺少 $t，请先安装。" }
}

# ---------- 1. 准备 .env（可选）----------
# 数据库默认内嵌 SQLite（lingfang.db，自动创建），无需任何外部服务。
# .env 可用于自定义 BIND_ADDR / DATABASE_URL / PLATFORM_ADMIN_EMAIL 等。
$envPath = Join-Path $Root '.env'
if ((-not (Test-Path $envPath)) -and (Test-Path (Join-Path $Root '.env.example'))) {
  Info "未找到 .env，从 .env.example 复制…"
  Copy-Item (Join-Path $Root '.env.example') $envPath
  Warn "已生成 .env，使用默认开发配置。如需自定义请编辑：$envPath"
}

$bindAddr = '127.0.0.1:8787'
if (Test-Path $envPath) {
  $line = (Get-Content $envPath | Where-Object { $_ -match '^BIND_ADDR=' } | Select-Object -First 1)
  if ($line) { $bindAddr = $line -replace '^BIND_ADDR=', '' }
}

# ---------- 2. 启动服务端 ----------
Info "编译并启动服务端（内嵌 SQLite，首次编译会拉取依赖，请稍候）…"
$logDir = Join-Path $Root 'night_runs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$serverLog = Join-Path $logDir 'server.log'
$serverProc = Start-Process -FilePath 'cargo' -ArgumentList 'run', '-p', 'server' `
  -WorkingDirectory $Root -PassThru -NoNewWindow `
  -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $logDir 'server.err.log')

# ---------- 3. 等待服务端健康 ----------
$healthUrl = "http://$bindAddr/health"
Info "等待服务端健康（$healthUrl）…"
$up = $false
foreach ($i in 1..90) {
  if ($serverProc.HasExited) { Die "服务端进程已退出（退出码 $($serverProc.ExitCode)）。查看日志：$serverLog" }
  try {
    $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 -ErrorAction Stop
    if ($resp.status -eq 'ok') { $up = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $up) { Die "服务端在 180 秒内未就绪。查看日志：$serverLog" }
Ok "服务端已就绪：http://$bindAddr"

# ---------- 4. 启动桌面壳 ----------
if ($SkipDesktop) {
  Ok "后端已启动（-SkipDesktop）。服务端日志：$serverLog"
  Info "停止：结束 cargo 进程（PID $($serverProc.Id)）。"
  exit 0
}

Info "启动桌面壳（Tauri）…"
try {
  pnpm -C apps/desktop dev
} finally {
  # 桌面壳关闭后，清理服务端进程。
  Info "桌面壳已退出，停止服务端…"
  if (-not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue }
  Ok "已停止。"
}
