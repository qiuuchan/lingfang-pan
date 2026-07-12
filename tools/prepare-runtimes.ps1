# Maintainer-only refresh for the committed Windows x64 runtime payload.
# Daily development and packaging never call this script.
param(
  [switch]$RefreshChromium
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $Root 'apps/desktop/runtimes'
$LockPath = Join-Path $RuntimeRoot 'runtime-lock.json'

if (-not (Test-Path -LiteralPath $LockPath)) {
  throw "缺少运行时锁文件：$LockPath"
}

if ($RefreshChromium) {
  $env:PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = 'win64'
  $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $RuntimeRoot 'chromium/ms-playwright'
  Push-Location $Root
  try {
    pnpm exec playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "Playwright Chromium 更新失败（exit $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }
}

Push-Location $Root
try {
  node scripts/materialize-bundled-runtimes.mjs $RuntimeRoot
  if ($LASTEXITCODE -ne 0) { throw "运行时还原失败（exit $LASTEXITCODE）" }
  node scripts/verify-bundled-runtimes.mjs $RuntimeRoot
  if ($LASTEXITCODE -ne 0) { throw "运行时校验失败（exit $LASTEXITCODE）" }
} finally {
  Pop-Location
}

Write-Host '运行时目录已验证。升级 Node/Python/FFmpeg 后必须同步更新 runtime-lock.json 的版本、大小和 SHA256，再提交全部文件。'
