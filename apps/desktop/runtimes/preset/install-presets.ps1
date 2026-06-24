#requires -Version 5.1
<#
.SYNOPSIS
  把预装包安装进灵方桌面端内置运行时（runtimes/python、runtimes/nodejs）。

.DESCRIPTION
  打包前执行一次即可，安装产物（site-packages、node_modules 全局包）随 runtimes/ 提交到仓库。
  - Python：按 requirements.txt 装入内置 Python 的 site-packages。
  - Node：按 node-globals.json 全局装入内置 Node（npm prefix 指向 runtimes/nodejs）。
  镜像源与 EmbeddedRuntime（src-tauri/src/embedded_runtime.rs）保持一致：清华 pip、npmmirror。

.PARAMETER SkipPython
  跳过 Python 预装。

.PARAMETER SkipNode
  跳过 Node 预装。

.EXAMPLE
  pwsh apps/desktop/runtimes/preset/install-presets.ps1
#>
param(
  [switch]$SkipPython,
  [switch]$SkipNode
)

$ErrorActionPreference = 'Stop'

$PresetDir   = $PSScriptRoot
$RuntimesDir = Split-Path -Parent $PresetDir
$PythonExe   = Join-Path $RuntimesDir 'python\python.exe'
$NodeDir     = Join-Path $RuntimesDir 'nodejs'
$NpmCli      = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
$NodeExe     = Join-Path $NodeDir 'node.exe'

# 与 embedded_runtime.rs 中的常量保持一致
$PipIndexUrl   = 'https://pypi.tuna.tsinghua.edu.cn/simple'
$PipTrustedHost = 'pypi.tuna.tsinghua.edu.cn'
$NpmRegistry   = 'https://registry.npmmirror.com'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

if (-not $SkipPython) {
  if (-not (Test-Path $PythonExe)) { throw "找不到内置 Python：$PythonExe" }
  $req = Join-Path $PresetDir 'requirements.txt'
  if (-not (Test-Path $req)) { throw "找不到 requirements.txt：$req" }

  Write-Step "升级内置 Python 的 pip"
  & $PythonExe -m pip install --upgrade pip `
    --index-url $PipIndexUrl --trusted-host $PipTrustedHost --disable-pip-version-check
  if ($LASTEXITCODE -ne 0) { throw "pip 自升级失败（exit $LASTEXITCODE）" }

  Write-Step "按 requirements.txt 预装 Python 包"
  & $PythonExe -m pip install -r $req `
    --index-url $PipIndexUrl --trusted-host $PipTrustedHost --disable-pip-version-check
  if ($LASTEXITCODE -ne 0) { throw "Python 预装失败（exit $LASTEXITCODE）" }
}

if (-not $SkipNode) {
  if (-not (Test-Path $NodeExe)) { throw "找不到内置 Node：$NodeExe" }
  if (-not (Test-Path $NpmCli))  { throw "找不到内置 npm：$NpmCli" }
  $manifest = Join-Path $PresetDir 'node-globals.json'
  if (-not (Test-Path $manifest)) { throw "找不到 node-globals.json：$manifest" }

  $globals = (Get-Content $manifest -Raw | ConvertFrom-Json).globals
  $specs = @()
  foreach ($p in $globals.PSObject.Properties) { $specs += "$($p.Name)@$($p.Value)" }

  if ($specs.Count -gt 0) {
    Write-Step "全局预装 Node 工具链：$($specs -join ', ')"
    # --prefix 指向 runtimes/nodejs，使全局包落在内置运行时内
    & $NodeExe $NpmCli install --global --prefix $NodeDir --registry $NpmRegistry @specs
    if ($LASTEXITCODE -ne 0) { throw "Node 预装失败（exit $LASTEXITCODE）" }
  } else {
    Write-Step "node-globals.json 无全局包，跳过"
  }
}

Write-Step "预装完成"
