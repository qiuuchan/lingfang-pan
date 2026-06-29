# Tauri 官方 NSIS 安装包打包脚本（包 A：治本路径）。
#
# 产出：release\LingFang-<version>-Setup.exe（Tauri 官方 NSIS 安装器）
#
# 与 build-installer.ps1（自制 SFX，包 B 第三方缓解）并存：
#   - 本脚本：官方 NSIS，信誉好、可签名、长期治本
#   - build-installer.ps1：自制 SFX，体积小、免 NSIS 工具链、作为备选
#
# NSIS 安装到 %LOCALAPPDATA%\<productName>（currentUser 模式，免提权），
# 与 update.rs 的路径逻辑对齐（installer/paths.rs 默认 LOCALAPPDATA\LingFang）。
#
# 用法：pwsh tools/build-nsis.ps1 [-OutputDir release]
param(
  [string]$OutputDir = 'release'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# --- 读版本号 ---
$confPath = Join-Path $Root 'apps/desktop/src-tauri/tauri.conf.json'
$conf = Get-Content -Raw -LiteralPath $confPath | ConvertFrom-Json
$Version = $conf.version
Write-Host "[1/4] 版本号：$Version"

# --- tauri build（出 NSIS 包）---
# tauri.conf.json 已配 bundle.active=true + targets=["nsis"]，故直接 tauri build。
# 自动跑 beforeBuildCommand（pnpm vite:build）编译前端 + 嵌入 + NSIS 打包。
# 首次构建会自动下载 NSIS 工具链（Tauri 自带），稍慢。
Write-Host '[2/4] tauri build（含前端编译 + NSIS 打包）…'
Push-Location (Join-Path $Root 'apps/desktop')
try {
  pnpm exec tauri build
  if ($LASTEXITCODE -ne 0) { throw "tauri build 失败（exit $LASTEXITCODE）" }
} finally {
  Pop-Location
}

# --- 定位 NSIS 产物 ---
# NSIS 产物命名含版本号与 productName，取「本次版本 + 最新修改时间」的那个，
# 避免目录里残留的旧版本包被误选（Get-ChildItem 按 LastWriteTime 降序取首个）。
$NsisDir = Join-Path $Root "target/release/bundle/nsis"
if (-not (Test-Path -LiteralPath $NsisDir)) {
  throw "未找到 NSIS 产物目录：$NsisDir（检查 tauri.conf.json bundle 配置）"
}
$NsisExe = Get-ChildItem -LiteralPath $NsisDir -Filter '*-setup.exe' |
  Where-Object { $_.Name -like "*$Version*" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $NsisExe) { throw "NSIS 产物目录无匹配版本 $Version 的 setup.exe（残留旧包？清理 nsis 目录后重试）" }
Write-Host "[3/4] NSIS 产物：$($NsisExe.Name)（$([math]::Round($NsisExe.Length / 1MB, 1)) MB）"

# --- 复制到 release/（统一命名，便于上传）---
$OutputName = "LingFang-$Version-Setup.exe"
$Dest = Join-Path $Root "$OutputDir/$OutputName"
New-Item -ItemType Directory -Force -Path (Join-Path $Root $OutputDir) | Out-Null
Copy-Item -LiteralPath $NsisExe.FullName -Destination $Dest -Force

# --- SHA-256 ---
$Hash = (Get-FileHash -LiteralPath $Dest -Algorithm SHA256).Hash.ToLower()
Write-Host "[4/4] SHA-256：$Hash"

Write-Host ""
Write-Host "========================================"
Write-Host " 官方 NSIS 安装包已生成：$OutputDir\$OutputName"
Write-Host " 体积：$([math]::Round($NsisExe.Length / 1MB, 1)) MB"
Write-Host " SHA-256：$Hash"
Write-Host "========================================"
Write-Host "提示：NSIS 安装器信誉好，可叠加代码签名证书进一步消除拦截。"
