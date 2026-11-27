# Lay out Faravan for Windows with its own Node.js runtime (D6). NOT RUN: written on Linux with no Windows to test on.
# Needs Windows PowerShell 5.1 or newer, Go, Git for Windows (bash, for stage-app.sh) and the pinned Node archive.
#
#   .\packaging\windows\build-layout.ps1 -Version 0.1.0 -Arch x64 -Out .\packaging\windows\dist
#
# Result: <Out>\Faravan\ with CLI wrappers, tray and resident executables, faravan.exe, the task registrar, and app\, unsigned.
# Packaging it as a signed MSIX is packaging/windows/build-msix.ps1 (D5).
param([string]$Version = '0.1.0', [ValidateSet('x64','arm64')][string]$Arch = 'x64', [string]$Out = "$PSScriptRoot\dist")
$ErrorActionPreference = 'Stop'
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
$packaging = Split-Path $PSScriptRoot -Parent
$layout = Join-Path $Out 'Faravan'
if (Test-Path $layout) { Remove-Item -Recurse -Force $layout }
New-Item -ItemType Directory -Force -Path $layout | Out-Null

# The shared steps are bash scripts; Git for Windows provides bash.
$bash = (Get-Command bash.exe).Source
function ToBashPath($p) { ($p -replace '\\','/') -replace '^([A-Za-z]):','/$1' }
& $bash (ToBashPath "$packaging\stage-app.sh") (ToBashPath "$layout\app") $Version
if ($LASTEXITCODE -ne 0) { throw "stage-app.sh failed with exit code $LASTEXITCODE" }
& $bash (ToBashPath "$packaging\bundle-node.sh") win $Arch (ToBashPath "$layout\app")
if ($LASTEXITCODE -ne 0) { throw "bundle-node.sh failed with exit code $LASTEXITCODE" }

# Record every staged app file so packaging can detect an incomplete layout.
$app = Join-Path $layout 'app'
Get-ChildItem -LiteralPath $app -File -Recurse | ForEach-Object { $_.FullName.Substring($app.Length + 1) } |
  Sort-Object | Set-Content -Encoding UTF8 (Join-Path $layout 'app-files.txt')

$goarch = if ($Arch -eq 'arm64') { 'arm64' } else { 'amd64' }
Push-Location (Join-Path (Split-Path $packaging -Parent) 'tray')
try {
  $env:GOOS = 'windows'; $env:GOARCH = $goarch
  go build -trimpath -ldflags '-H=windowsgui' -o "$layout\faravan-tray.exe" ./cmd/faravan-tray
  if ($LASTEXITCODE -ne 0) { throw "go build faravan-tray failed with exit code $LASTEXITCODE" }
  go build -trimpath -ldflags '-H=windowsgui' -o "$layout\faravan-resident.exe" ./cmd/faravan-resident
  if ($LASTEXITCODE -ne 0) { throw "Resident launcher build failed with exit code $LASTEXITCODE" }
  go build -trimpath -o "$layout\faravan.exe" ./cmd/faravan-cli
  if ($LASTEXITCODE -ne 0) { throw "go build faravan failed with exit code $LASTEXITCODE" }
}
finally { Pop-Location; Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue }
Copy-Item (Join-Path $PSScriptRoot 'register-resident.ps1') (Join-Path $layout 'register-resident.ps1')

# The launcher uses the bundled node.exe, found from its own folder: nothing on PATH is used.
@'
@echo off
"%~dp0app\runtime\node.exe" "%~dp0app\bin\faravan" %*
'@ | Set-Content -Encoding ASCII (Join-Path $layout 'faravan.cmd')
@'
@echo off
"%~dp0app\runtime\node.exe" "%~dp0app\bin\faravan" %*
'@ | Set-Content -Encoding ASCII (Join-Path $layout 'faravan.cmd')
Write-Host "built $layout (unsigned, untested)"
