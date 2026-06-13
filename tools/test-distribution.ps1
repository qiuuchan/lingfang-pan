$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $PSScriptRoot 'create-distribution.ps1'
$OutDir = Join-Path 'O:\tmp' 'lingfang-dist-test'
$ExtractDir = Join-Path 'O:\tmp' 'lingfang-dist-extract'

function Reset-Directory($Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith('O:\tmp\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理非测试目录：$full"
  }
  if (Test-Path -LiteralPath $full) {
    Remove-Item -LiteralPath $full -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $full | Out-Null
}

function Assert-True($Name, $Condition) {
  if (-not $Condition) {
    throw "断言失败：$Name"
  }
  Write-Output "  [OK] $Name"
}

function Assert-Entry($RootPath, $RelativePath) {
  $path = Join-Path $RootPath $RelativePath
  Assert-True "包含 $RelativePath" (Test-Path -LiteralPath $path)
}

function Assert-MissingEntry($RootPath, $RelativePath) {
  $path = Join-Path $RootPath $RelativePath
  Assert-True "不包含 $RelativePath" (-not (Test-Path -LiteralPath $path))
}

Reset-Directory $OutDir
Reset-Directory $ExtractDir

if (-not (Test-Path -LiteralPath $ScriptPath)) {
  throw "缺少分发脚本：$ScriptPath"
}

$TestEnvPath = Join-Path $Root '.env.test-dist'
Set-Content -LiteralPath $TestEnvPath -Value 'SHOULD_NOT_PACKAGE=true' -Encoding UTF8
try {
  $json = & $ScriptPath -OutputDir $OutDir -PackageName 'lingfang-platform-test' -Timestamp 'test' -Json
} finally {
  if (Test-Path -LiteralPath $TestEnvPath) {
    Remove-Item -LiteralPath $TestEnvPath -Force
  }
}
$result = $json | ConvertFrom-Json
$zipPath = $result.zip_path

Assert-True '生成 zip 文件' (Test-Path -LiteralPath $zipPath)
Expand-Archive -LiteralPath $zipPath -DestinationPath $ExtractDir -Force

$PackageRoot = Join-Path $ExtractDir 'lingfang-platform-test-test'
Assert-Entry $PackageRoot 'README.md'
Assert-Entry $PackageRoot 'DISTRIBUTION.md'
Assert-Entry $PackageRoot 'package.json'
Assert-Entry $PackageRoot '.env.example'
Assert-Entry $PackageRoot 'apps\collab-api\src\main.ts'
Assert-Entry $PackageRoot 'apps\desktop\src\main.tsx'
Assert-Entry $PackageRoot 'packages\contract\src\index.ts'
Assert-Entry $PackageRoot 'plugins\summarizer\manifest.json'
Assert-Entry $PackageRoot 'tools\start.ps1'

Assert-MissingEntry $PackageRoot '.env'
Assert-MissingEntry $PackageRoot '.env.test-dist'
Assert-MissingEntry $PackageRoot 'node_modules'
Assert-MissingEntry $PackageRoot 'target'
Assert-MissingEntry $PackageRoot 'night_runs'
Assert-MissingEntry $PackageRoot '.claude'
Assert-MissingEntry $PackageRoot '.codex'
Assert-MissingEntry $PackageRoot '.agents'
Assert-MissingEntry $PackageRoot 'apps\desktop\dist'

Write-Output '分发包内容检查通过'
