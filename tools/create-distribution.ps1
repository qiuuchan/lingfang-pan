param(
  [string]$OutputDir = 'release',
  [string]$PackageName = 'lingfang-platform',
  [string]$Timestamp = (Get-Date -Format 'yyyyMMdd-HHmmss'),
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$RootName = "$PackageName-$Timestamp"
$PackageRoot = Join-Path $OutputDir $RootName
$ZipPath = Join-Path $OutputDir "$RootName.zip"

$IncludedRootEntries = @(
  'Cargo.toml',
  'Cargo.lock',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'README.md',
  '.env.example',
  '.gitignore',
  'docker-compose.yml',
  'apps',
  'packages',
  'plugins',
  'docs',
  'tools'
)

$BlockedDirectories = @(
  '.agents',
  '.claude',
  '.codex',
  '.cursor',
  '.git',
  'dist',
  'night_runs',
  'node_modules',
  'release',
  'target'
)

$BlockedFiles = @(
  '.env'
)

$BlockedExtensions = @(
  '.log',
  '.pdb'
)

function Get-FullPath($Path) {
  if ([System.IO.Path]::IsPathFullyQualified($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $Root $Path))
}

function Assert-ChildPath($Parent, $Child) {
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $childFull = [System.IO.Path]::GetFullPath($Child)
  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "路径越界：$childFull 不在 $parentFull 内"
  }
}

function Assert-AllowedOutput($Path) {
  $workspace = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $tmp = [System.IO.Path]::GetFullPath('O:\tmp').TrimEnd('\') + '\'
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\') + '\'
  if ($full.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
    return
  }
  if ($full.StartsWith($tmp, [System.StringComparison]::OrdinalIgnoreCase)) {
    return
  }
  throw "输出目录必须在仓库或 O:\tmp 内：$full"
}

function Reset-PackageDirectory($OutDir, $PkgRoot, $ZipFile) {
  $outputFull = Get-FullPath $OutDir
  $packageFull = Get-FullPath $PkgRoot
  $zipFull = Get-FullPath $ZipFile

  Assert-AllowedOutput $outputFull
  Assert-ChildPath $outputFull $packageFull
  Assert-ChildPath $outputFull $zipFull

  if (Test-Path -LiteralPath $packageFull) {
    Remove-Item -LiteralPath $packageFull -Recurse -Force
  }
  if (Test-Path -LiteralPath $zipFull) {
    Remove-Item -LiteralPath $zipFull -Force
  }
  New-Item -ItemType Directory -Force -Path $packageFull | Out-Null
}

function Get-RelativePath($BasePath, $ChildPath) {
  $baseUri = [System.Uri](([System.IO.Path]::GetFullPath($BasePath).TrimEnd('\')) + '\')
  $childUri = [System.Uri]([System.IO.Path]::GetFullPath($ChildPath))
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($childUri).ToString()).Replace('/', '\')
}

function Test-BlockedPath($RelativePath) {
  $segments = $RelativePath -split '[\\/]'
  foreach ($segment in $segments) {
    if ($BlockedDirectories -contains $segment) {
      return $true
    }
  }

  $leaf = Split-Path -Leaf $RelativePath
  if ($BlockedFiles -contains $leaf) {
    return $true
  }
  if ($leaf.StartsWith('.env.', [System.StringComparison]::OrdinalIgnoreCase)) {
    return $leaf -ne '.env.example'
  }

  $extension = [System.IO.Path]::GetExtension($RelativePath)
  return $BlockedExtensions -contains $extension
}

function Copy-DistributionFile($SourcePath, $DestinationRoot, $RelativePath) {
  if (Test-BlockedPath $RelativePath) {
    return
  }

  $target = Join-Path $DestinationRoot $RelativePath
  $targetDir = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  Copy-Item -LiteralPath $SourcePath -Destination $target -Force
}

function Copy-DistributionEntry($Entry, $DestinationRoot) {
  $source = Join-Path $Root $Entry
  if (-not (Test-Path -LiteralPath $source)) {
    return
  }

  $item = Get-Item -LiteralPath $source
  if (-not $item.PSIsContainer) {
    Copy-DistributionFile $item.FullName $DestinationRoot $Entry
    return
  }

  Get-ChildItem -LiteralPath $item.FullName -Recurse -File -Force | ForEach-Object {
    $relative = Get-RelativePath $Root $_.FullName
    Copy-DistributionFile $_.FullName $DestinationRoot $relative
  }
}

function Write-DistributionReadme($DestinationRoot) {
  $content = @'
# LingFang 分发包说明

## 可以打包

- 源码：`apps/`、`packages/`、`plugins/`
- 工程文件：`Cargo.toml`、`Cargo.lock`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`
- 启动与验证脚本：`tools/`
- 文档与配置模板：`README.md`、`docs/`、`.env.example`、`docker-compose.yml`

## 不能打包

- 本机密钥与环境：`.env`、`.env.*`（`.env.example` 除外）
- 依赖与构建缓存：`node_modules/`、`target/`、`dist/`
- 运行日志与临时输出：`night_runs/`、`*.log`
- 个人工具配置：`.claude/`、`.cursor/`、`.codex/`、`.agents/`

## 接收方启动

1. 安装 Node.js 20+、pnpm 9+、Rust/Cargo、PowerShell 7。
2. 在包根目录运行 `pnpm install`。
3. 按需复制 `.env.example` 为 `.env` 并修改配置。
4. 运行 `pnpm start`。
'@
  Set-Content -LiteralPath (Join-Path $DestinationRoot 'DISTRIBUTION.md') -Value $content -Encoding UTF8
}

function New-DistributionPackage {
  $outputFull = Get-FullPath $OutputDir
  $packageFull = Get-FullPath $PackageRoot
  $zipFull = Get-FullPath $ZipPath

  Reset-PackageDirectory $OutputDir $PackageRoot $ZipPath
  foreach ($entry in $IncludedRootEntries) {
    Copy-DistributionEntry $entry $packageFull
  }

  Write-DistributionReadme $packageFull
  Compress-Archive -LiteralPath $packageFull -DestinationPath $zipFull -CompressionLevel Optimal

  return [pscustomobject]@{
    package_root = $packageFull
    zip_path = $zipFull
    output_dir = $outputFull
  }
}

$result = New-DistributionPackage
if ($Json) {
  $result | ConvertTo-Json -Compress
} else {
  Write-Output "[LingFang] 分发包已生成：$($result.zip_path)"
  Write-Output "[LingFang] 解压目录：$($result.package_root)"
}
