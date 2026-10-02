$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDirectory
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Please install Node.js 24 LTS first.' }
if (-not (Test-Path -LiteralPath 'node_modules')) {
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
# Always build the current source to avoid accidentally starting an older version.
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& npm.cmd start
exit $LASTEXITCODE
