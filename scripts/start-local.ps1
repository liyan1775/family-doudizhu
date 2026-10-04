param([switch]$PublicRoom)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDirectory
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '请先安装 Node.js 24 LTS，然后重新双击“启动游戏”。' -ForegroundColor Yellow
    exit 1
  }
  $taskNodeVersion = (& node -p 'process.versions.node').Split('.')
  if ([int]$taskNodeVersion[0] -lt 22 -or ([int]$taskNodeVersion[0] -eq 22 -and [int]$taskNodeVersion[1] -lt 12)) {
    Write-Host 'Node.js 版本过旧，请安装 Node.js 24 LTS 后重新双击“启动游戏”。' -ForegroundColor Yellow
    exit 1
  }
  if ($PublicRoom) {
    & node (Join-Path $PSScriptRoot 'start-local.mjs') --public
  } else {
    & node (Join-Path $PSScriptRoot 'start-local.mjs')
  }
  exit $LASTEXITCODE
} catch {
  Write-Host '游戏没有启动成功。请保留下面的提示，交给项目维护者检查：' -ForegroundColor Yellow
  Write-Host $_.Exception.Message
  exit 1
}
