# LingFang 一键启动脚本（Windows / PowerShell）。
#
# 流程：检查依赖 → 校验 collab-api 配置 → 确保数据库可连 → 迁移/同步+建管理员 →
#       启动 collab-api（NestJS，端口取 .env 的 PORT）→ 等待健康 → 启动桌面壳（Tauri）。
#
# 后端为 apps/collab-api（NestJS，/api/* 前缀，支持 PostgreSQL 16+ 或 MySQL 8+/MariaDB）。
# 历史服务实现已退役；当前只启动 apps/collab-api。
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

function Get-UriUserInfo($uri) {
  $parts = ($uri.UserInfo -split ':', 2)
  $user = if ($parts.Count -ge 1) { [Uri]::UnescapeDataString($parts[0]) } else { '' }
  $password = if ($parts.Count -eq 2) { [Uri]::UnescapeDataString($parts[1]) } else { $null }
  return @{ User = $user; Password = $password }
}

function Invoke-MySqlPreflight($mysql, $databaseUrl) {
  $url = [Uri]$databaseUrl
  $credentials = Get-UriUserInfo $url
  $dbName = [Uri]::UnescapeDataString($url.AbsolutePath.TrimStart('/'))
  $portValue = if ($url.Port -gt 0) { $url.Port } else { 3306 }
  $hadMysqlPwd = Test-Path Env:MYSQL_PWD
  $previousMysqlPwd = $env:MYSQL_PWD
  try {
    if ($null -ne $credentials.Password) { $env:MYSQL_PWD = $credentials.Password }
    $args = @(
      "--host=$($url.Host)",
      "--port=$portValue",
      "--user=$($credentials.User)",
      '--protocol=tcp',
      '--batch',
      '--skip-column-names',
      '--execute',
      'SELECT 1;',
      $dbName
    )
    return & $mysql @args 2>&1
  } finally {
    if ($hadMysqlPwd) { $env:MYSQL_PWD = $previousMysqlPwd }
    else { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }
  }
}

function Invoke-PostgresPreflight($psql, $databaseUrl) {
  $url = [Uri]$databaseUrl
  $credentials = Get-UriUserInfo $url
  $dbName = [Uri]::UnescapeDataString($url.AbsolutePath.TrimStart('/'))
  $portValue = if ($url.Port -gt 0) { $url.Port } else { 5432 }
  $hadPgPassword = Test-Path Env:PGPASSWORD
  $previousPgPassword = $env:PGPASSWORD
  try {
    if ($null -ne $credentials.Password) { $env:PGPASSWORD = $credentials.Password }
    return & $psql -h $url.Host -p $portValue -U $credentials.User -d $dbName -tAc "SELECT 1;" 2>&1
  } finally {
    if ($hadPgPassword) { $env:PGPASSWORD = $previousPgPassword }
    else { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
  }
}

$databaseUrl = Get-EnvVar $envPath 'DATABASE_URL'
if (-not $databaseUrl) { Die "apps/collab-api/.env 缺少 DATABASE_URL，请检查配置。" }
$databaseProvider = Get-EnvVar $envPath 'DATABASE_PROVIDER'
if (-not $databaseProvider) { $databaseProvider = 'postgresql' }
$port = Get-EnvVar $envPath 'PORT'
if (-not $port) { $port = '3000' }

# ---------- 2. 检查端口未被占用 ----------
$portBusy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($portBusy) {
  Die "端口 $port 已被占用（PID $($portBusy.OwningProcess -join ',')）。请先停止占用该端口的进程，或修改 .env 的 PORT。"
}

# ---------- 3. 检查数据库连通性 ----------
if ($databaseProvider -eq 'mysql') {
  $mysql = $null
  foreach ($cand in @('C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe', 'C:\Program Files\MariaDB 11.0\bin\mysql.exe', 'C:\Program Files\MariaDB 10.11\bin\mysql.exe')) {
    if (Test-Path $cand) { $mysql = $cand; break }
  }
  if ($mysql) {
    Info "检查 MySQL 连通性…"
    $connTest = Invoke-MySqlPreflight $mysql $databaseUrl
    $connOk = $LASTEXITCODE -eq 0
    if (-not $connOk) {
      Write-Host $connTest -ForegroundColor DarkGray
      Die "数据库未就绪。请先确认 MySQL 用户、库名和密码正确，然后重新运行 pnpm start。"
    }
    Ok "MySQL 连通正常。"
  } else {
    Warn "未找到 mysql.exe，跳过 MySQL 连通性预检（将依赖 Prisma 自身的连接错误报告）。"
  }
} else {
  $psql = $null
  foreach ($ver in @('18','17','16','15')) {
    $cand = "C:\Program Files\PostgreSQL\$ver\bin\psql.exe"
    if (Test-Path $cand) { $psql = $cand; break }
  }

  if ($psql) {
    Info "检查 PostgreSQL 连通性…"
    $connTest = Invoke-PostgresPreflight $psql $databaseUrl
    $connOk = $LASTEXITCODE -eq 0
    if (-not $connOk) {
      Warn "无法连接 DATABASE_URL 指向的 PostgreSQL 数据库。"
      Write-Host $connTest -ForegroundColor DarkGray
      Die "数据库未就绪。请先按 DATABASE_URL 创建用户和数据库；默认开发配置可参考：
  psql -U postgres -d postgres -c `"CREATE USER lingfang WITH PASSWORD 'lingfang';`"
  psql -U postgres -d postgres -c `"CREATE DATABASE lingfang_collab OWNER lingfang LOCALE 'C' TEMPLATE template0;`"
完成后重新运行 pnpm start。详见 docs/collab-deployment.md。"
    }
    Ok "PostgreSQL 连通正常。"
  } else {
    Warn "未找到 psql.exe，跳过 PostgreSQL 连通性预检（将依赖 Prisma 自身的连接错误报告）。"
  }
}

# ---------- 4. 迁移 / 同步 + 建平台管理员 ----------
Info "生成 Prisma Client + 应用数据库结构…"
& pnpm -C $collabDir prisma:generate 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { Die "Prisma 客户端生成失败。请检查 DATABASE_PROVIDER / DATABASE_URL 与依赖安装。" }
& pnpm -C $collabDir prisma:deploy 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { Die "Prisma 迁移/部署失败。请检查 DATABASE_URL 与数据库状态。" }

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
