# Pack and sign Faravan as an MSIX (D5). NOT RUN: it needs Windows, the Windows SDK (makeappx, signtool) and a code
# signing certificate, none of which exist yet (decision T27). Nothing here creates or asks for a certificate.
#
#   .\packaging\windows\build-msix.ps1 -Layout .\packaging\windows\dist\Faravan -Version 0.1.0 [-Arch x64] [-Out .\dist] [-DryRun]
#
# Identities come only from the environment:
#   FARAVAN_WIN_PUBLISHER        the certificate's Subject exactly, e.g. "CN=Example Ltd, O=Example Ltd, C=US"
#   FARAVAN_WIN_PUBLISHER_DISPLAY  the name people see (optional; defaults to the CN)
#   one way to sign, either
#     FARAVAN_WIN_CERT_THUMBPRINT   a certificate already in the user's or machine's store (preferred: no secret in a command line)
#     FARAVAN_WIN_CERT_PFX + FARAVAN_WIN_CERT_PASSWORD   a .pfx file and its password (the password is visible to other
#                                    processes while signtool runs; use only on a build machine you control)
# Optional: FARAVAN_WIN_TIMESTAMP_URL (default http://timestamp.digicert.com), FARAVAN_WIN_PACKAGE_NAME (default Faravan.Faravan).
# -DryRun prints each command and runs none (used by the tests, with stub tools).
param(
  [Parameter(Mandatory)][string]$Layout,
  [Parameter(Mandatory)][string]$Version,
  [ValidateSet('x64','arm64')][string]$Arch = 'x64',
  [string]$Out = '.',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$missing = @()
if (-not $env:FARAVAN_WIN_PUBLISHER) { $missing += 'FARAVAN_WIN_PUBLISHER' }
if (-not $env:FARAVAN_WIN_CERT_THUMBPRINT) {
  if (-not $env:FARAVAN_WIN_CERT_PFX) { $missing += 'FARAVAN_WIN_CERT_PFX (or FARAVAN_WIN_CERT_THUMBPRINT)' }
  elseif (-not $env:FARAVAN_WIN_CERT_PASSWORD) { $missing += 'FARAVAN_WIN_CERT_PASSWORD' }
}
if ($missing.Count -gt 0) {
  [Console]::Error.WriteLine("build-msix: missing $($missing -join ', '). Signing is off until the product owner decides on a code signing certificate (T27).")
  exit 2
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { [Console]::Error.WriteLine('build-msix: -Version must be like 0.1.0'); exit 2 }
foreach ($required in @('faravan-tray.exe', 'faravan.exe', 'faravan.cmd', 'faravan.cmd', 'app-files.txt',
    'app/runtime/node.exe', 'app/bin/faravan', 'app/bin/faravan', 'app/lib/v1/cli.mjs', 'app/package.json', 'app/VERSION',
    'Assets/StoreLogo.png', 'Assets/Square150x150Logo.png', 'Assets/Square44x44Logo.png')) {
  if (-not (Test-Path (Join-Path $Layout $required) -PathType Leaf)) {
    [Console]::Error.WriteLine("build-msix: $Layout is missing $required; rebuild it with build-layout.ps1")
    exit 2
  }
}
$appFiles = @(Get-Content (Join-Path $Layout 'app-files.txt'))
if ($appFiles.Count -eq 0) { [Console]::Error.WriteLine('build-msix: app-files.txt is empty; rebuild the layout'); exit 2 }
foreach ($file in $appFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $Layout 'app') $file) -PathType Leaf)) {
    [Console]::Error.WriteLine("build-msix: $Layout is missing app/$file; rebuild it with build-layout.ps1")
    exit 2
  }
}

function Invoke-Step([string]$Tool, [string[]]$Arguments, [string[]]$Hide = @()) {
  if ($DryRun) {
    $shown = $Arguments | ForEach-Object { $a = $_; foreach ($h in $Hide) { if ($h -and $a -eq $h) { $a = '<hidden>' } }; $a }
    Write-Output ("DRY-RUN: $Tool " + ($shown -join ' '))
    return
  }
  & $Tool @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Tool failed with exit code $LASTEXITCODE" }
}

$name = if ($env:FARAVAN_WIN_PACKAGE_NAME) { $env:FARAVAN_WIN_PACKAGE_NAME } else { 'Faravan.Faravan' }
$display = if ($env:FARAVAN_WIN_PUBLISHER_DISPLAY) { $env:FARAVAN_WIN_PUBLISHER_DISPLAY } elseif ($env:FARAVAN_WIN_PUBLISHER -match 'CN=([^,]+)') { $Matches[1] } else { 'Faravan' }
$escape = { param($v) [System.Security.SecurityElement]::Escape($v) }

# An MSIX version has four parts. The fourth is 0: the release process owns the first three.
$manifest = (Get-Content (Join-Path $PSScriptRoot 'AppxManifest.template.xml') -Raw) `
  -replace '@@NAME@@', (& $escape $name) -replace '@@PUBLISHER@@', (& $escape $env:FARAVAN_WIN_PUBLISHER) `
  -replace '@@PUBLISHER_DISPLAY@@', (& $escape $display) -replace '@@VERSION@@', "$Version.0" -replace '@@ARCH@@', $Arch
$staging = Join-Path ([IO.Path]::GetTempPath()) ("faravan-msix-" + [Guid]::NewGuid().ToString('N'))
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $staging | Out-Null }
try {
  # A dry run copies nothing; a real build stops on any copy error.
  if ($DryRun) { Write-Output "DRY-RUN: copy $Layout to $staging" }
  else { Copy-Item -Recurse -Force (Join-Path $Layout '*') $staging -ErrorAction Stop }
  if ($DryRun) { Write-Output "DRY-RUN: write manifest to $staging" }
  else { Set-Content -Encoding UTF8 -Path (Join-Path $staging 'AppxManifest.xml') -Value $manifest }
  $package = Join-Path $Out "Faravan-$Version-$Arch.msix"
  if ($DryRun) { Write-Output "DRY-RUN: create output directory $Out" }
  else { New-Item -ItemType Directory -Force -Path $Out | Out-Null }
  Invoke-Step 'makeappx' @('pack', '/d', $staging, '/p', $package, '/o')

  $stamp = if ($env:FARAVAN_WIN_TIMESTAMP_URL) { $env:FARAVAN_WIN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
  $sign = @('sign', '/fd', 'SHA256', '/tr', $stamp, '/td', 'SHA256')
  if ($env:FARAVAN_WIN_CERT_THUMBPRINT) { $sign += @('/sha1', $env:FARAVAN_WIN_CERT_THUMBPRINT) }
  else { $sign += @('/f', $env:FARAVAN_WIN_CERT_PFX, '/p', $env:FARAVAN_WIN_CERT_PASSWORD) }
  Invoke-Step 'signtool' ($sign + @($package)) -Hide @($env:FARAVAN_WIN_CERT_PASSWORD)
  Invoke-Step 'signtool' @('verify', '/pa', '/v', $package)
  Write-Output "build-msix: done. Gate 'clean-machine install' is NOT run: install the .msix on a Windows 11 machine that never built it."
}
finally { if (-not $DryRun) { Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue } }
