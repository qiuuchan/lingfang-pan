# 自制 Windows 安装包打包脚本（PRD R7/R8，design §9）。
#
# 串起：编译前端 → 编译主程序(release) → 编译 installer(release) → 收集 app 文件到 staging
#       → 压缩为 payload.zip → 拼接 [installer.exe][payload.zip][trailer] → 产出 LingFang-Setup-<ver>.exe。
#
# 自解压尾部格式（与 installer/src/sfx.rs 一致）：
#   [ installer.exe 原始字节 ][ payload.zip ][ MAGIC(8="LFSFX\0\0\0") + payload_len(u32 LE) = 12 字节 ]
#
# 产物里的 updater.exe = 干净 installer.exe（无 payload 尾部），供更新/卸载时运行（不带几百 MB 包袱）。
#
# 用法：pwsh tools/build-installer.ps1 [-SkipFrontend] [-OutputDir release]
param(
  [string]$OutputDir = 'release',
  [switch]$SkipFrontend
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# --- 读版本号（src-tauri/tauri.conf.json 的 version）---
$confPath = Join-Path $Root 'apps/desktop/src-tauri/tauri.conf.json'
$conf = Get-Content -Raw -LiteralPath $confPath | ConvertFrom-Json
$Version = $conf.version
Write-Host "[1/7] 版本号：$Version"

# --- 编译前端（vite）---
if (-not $SkipFrontend) {
  Write-Host '[2/7] 编译前端（pnpm vite:build）…'
  pnpm --filter @lingfang/desktop vite:build
} else {
  Write-Host '[2/7] 跳过前端编译（-SkipFrontend）'
}

# --- 编译主程序 + installer（release）---
Write-Host '[3/7] 编译主程序 lingfang-desktop（release）…'
cargo build --release -p lingfang-desktop
Write-Host '[4/7] 编译 installer（release）…'
cargo build --release -p lingfang-installer

$TargetDir = Join-Path $Root 'target/release'
$DesktopExe = Join-Path $TargetDir 'lingfang-desktop.exe'
$InstallerExe = Join-Path $TargetDir 'installer.exe'
foreach ($p in @($DesktopExe, $InstallerExe)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "缺少编译产物：$p" }
}

# --- 收集 app 文件到 staging ---
Write-Host '[5/7] 收集 app 文件到 staging…'
$Staging = Join-Path $OutputDir "staging-$Version"
if (Test-Path -LiteralPath $Staging) { Remove-Item -LiteralPath $Staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Staging | Out-Null

# 主程序 exe。
Copy-Item -LiteralPath $DesktopExe -Destination (Join-Path $Staging 'lingfang-desktop.exe') -Force
# updater.exe = 干净 installer.exe（无 payload）。
Copy-Item -LiteralPath $InstallerExe -Destination (Join-Path $Staging 'updater.exe') -Force
# 资源目录：runtimes / builtin-plugins（与 exe 同级，main.rs resource_dir 解析）。
Copy-Item -LiteralPath (Join-Path $Root 'apps/desktop/runtimes') -Destination (Join-Path $Staging 'runtimes') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $Root 'apps/desktop/builtin-plugins') -Destination (Join-Path $Staging 'builtin-plugins') -Recurse -Force
# 前端产物（Tauri webview 加载的 HTML/JS/CSS，tauri.conf.json frontendDist 指向 ../dist）。
Copy-Item -LiteralPath (Join-Path $Root 'apps/desktop/dist') -Destination (Join-Path $Staging 'dist') -Recurse -Force
# 图标（卸载器/快捷方式用）。
New-Item -ItemType Directory -Force -Path (Join-Path $Staging 'icons') | Out-Null
Copy-Item -LiteralPath (Join-Path $Root 'apps/desktop/src-tauri/icons/icon.ico') -Destination (Join-Path $Staging 'icons/icon.ico') -Force

# --- 压缩 staging 内容为 payload.zip ---
Write-Host '[6/7] 压缩 payload + 拼接自解压 EXE…'
$PayloadZip = Join-Path $OutputDir "payload-$Version.zip"
if (Test-Path -LiteralPath $PayloadZip) { Remove-Item -LiteralPath $PayloadZip -Force }
# 压缩 staging/* （不含 staging 顶层目录，使 zip 内路径为 lingfang-desktop.exe / runtimes/...）。
Compress-Archive -Path (Join-Path $Staging '*') -DestinationPath $PayloadZip -CompressionLevel Optimal

# --- 拼接 [installer.exe][payload.zip][trailer] → Setup.exe ---
$SetupExe = Join-Path $OutputDir "LingFang-Setup-$Version.exe"
if (Test-Path -LiteralPath $SetupExe) { Remove-Item -LiteralPath $SetupExe -Force }

$installerBytes = [System.IO.File]::ReadAllBytes($InstallerExe)
$payloadBytes = [System.IO.File]::ReadAllBytes($PayloadZip)
$payloadLen = [uint32]$payloadBytes.Length

# trailer = MAGIC(8) + payload_len(u32 LE)。
$magic = [byte[]]@(0x4C, 0x46, 0x53, 0x46, 0x58, 0x00, 0x00, 0x00) # "LFSFX\0\0\0"
$lenBytes = [System.BitConverter]::GetBytes($payloadLen)          # 小端（x86/x64 默认）
if (-not [System.BitConverter]::IsLittleEndian) { [Array]::Reverse($lenBytes) }

$fs = [System.IO.File]::Create($SetupExe)
try {
  $fs.Write($installerBytes, 0, $installerBytes.Length)
  $fs.Write($payloadBytes, 0, $payloadBytes.Length)
  $fs.Write($magic, 0, $magic.Length)
  $fs.Write($lenBytes, 0, $lenBytes.Length)
} finally {
  $fs.Dispose()
}

# --- 输出 sha256（供核对/上传后比对）---
Write-Host '[7/7] 计算 SHA-256…'
$hash = (Get-FileHash -LiteralPath $SetupExe -Algorithm SHA256).Hash.ToLower()
$sizeMb = [math]::Round((Get-Item -LiteralPath $SetupExe).Length / 1MB, 1)

# 清理中间产物（保留 Setup.exe）。
Remove-Item -LiteralPath $Staging -Recurse -Force
Remove-Item -LiteralPath $PayloadZip -Force

Write-Host ''
Write-Host '========================================'
Write-Host " 安装包已生成：$SetupExe"
Write-Host " 体积：$sizeMb MB"
Write-Host " SHA-256：$hash"
Write-Host '========================================'
Write-Host '提示：上传到管理后台「版本发布」时后端会自动计算 SHA-256，与上方值核对一致即可。'
