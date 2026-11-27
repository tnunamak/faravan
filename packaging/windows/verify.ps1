#Requires -Version 5.1
<#
.SYNOPSIS
Collect native Windows acceptance evidence across installation, reboot, upgrade and removal.
.DESCRIPTION
Read acceptance.md first. The candidate JSON pins reviewed source and exact MSIX bytes.
No elevation, execution-policy changes, certificate imports or provider requests are performed.
SignOff records a named person's attestation, not a cryptographic identity signature.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Baseline','Install','Inspect','AfterCrash','AfterReboot','Upgrade','Uninstall','SignOff')][string]$Phase,
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$RetainedFixtures,
    [string]$ManualEvidence,
    [string]$Operator
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This is the acceptance contract. Repeated IDs require both automatic and human evidence.
$CheckPlan = @(
    @{ Id = 'WIN-01'; Phase = 'Baseline' }
    @{ Id = 'WIN-02'; Phase = 'Baseline' }
    @{ Id = 'WIN-03'; Phase = 'Install' }
    @{ Id = 'WIN-04'; Phase = 'Inspect' }
    @{ Id = 'WIN-04'; Phase = 'Review' }
    @{ Id = 'WIN-05'; Phase = 'Review' }
    @{ Id = 'WIN-06'; Phase = 'Inspect' }
    @{ Id = 'WIN-07'; Phase = 'Inspect' }
    @{ Id = 'WIN-08'; Phase = 'Inspect' }
    @{ Id = 'WIN-09'; Phase = 'AfterCrash' }
    @{ Id = 'WIN-09'; Phase = 'Review' }
    @{ Id = 'WIN-10'; Phase = 'AfterReboot' }
    @{ Id = 'WIN-10'; Phase = 'Review' }
    @{ Id = 'WIN-11'; Phase = 'Upgrade' }
    @{ Id = 'WIN-11'; Phase = 'Review' }
    @{ Id = 'WIN-12'; Phase = 'Uninstall' }
    @{ Id = 'WIN-12'; Phase = 'Review' }
    @{ Id = 'WIN-13'; Phase = 'Inspect' }
    @{ Id = 'WIN-14'; Phase = 'Inspect' }
    @{ Id = 'WIN-14'; Phase = 'Review' }
    @{ Id = 'WIN-15'; Phase = 'Review' }
    @{ Id = 'WIN-16'; Phase = 'Inspect' }
    @{ Id = 'WIN-16'; Phase = 'Review' }
    @{ Id = 'WIN-17'; Phase = 'Review' }
    @{ Id = 'WIN-18'; Phase = 'Inspect' }
    @{ Id = 'WIN-18'; Phase = 'Review' }
    @{ Id = 'WIN-19'; Phase = 'Review' }
    @{ Id = 'WIN-20'; Phase = 'Review' }
)

function Read-JsonFile([string]$Path) {
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-JsonFile([string]$Path, $Value) {
    $json = $Value | ConvertTo-Json -Depth 24
    [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

function Enter-ReceiptLock([string]$Directory) {
    # Reuse this pathname forever. Existence does not mean ownership; the open handle does.
    $path = Join-Path $Directory 'receipt.lock'
    try {
        return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
        throw "Cannot open exclusive receipt lock; another invocation may own this directory. $($_.Exception.Message)"
    }
}

$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
$receiptPath = Join-Path $OutputDirectory 'receipt.json'
$receiptLock = Enter-ReceiptLock $OutputDirectory
# This outer lifetime includes initialization, every phase, and the final digest write.
try {
$candidateHash = (Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash.ToLowerInvariant()
$packHashes = [ordered]@{}
foreach ($file in @('verify.ps1','native-probes.mjs','acceptance.md')) {
    $packHashes[$file] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$packJson = $packHashes | ConvertTo-Json -Compress
$config = Read-JsonFile $Candidate
foreach ($build in @($config.build, $config.upgrade)) {
    if ($build.commit -notmatch '^[0-9a-f]{40}$' -or $build.sha256 -notmatch '^[0-9a-f]{64}$' -or
        -not [IO.Path]::IsPathRooted($build.artifact) -or $build.artifact -notlike '*.msix') {
        throw 'Candidate requires full lowercase commit/SHA256 and absolute .msix paths for both builds.'
    }
}
if ($config.packageName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]+$') { throw 'Invalid exact MSIX package name.' }
if (Test-Path -LiteralPath $receiptPath) {
    $state = Read-JsonFile $receiptPath
    if ($state.candidateSha256 -ne $candidateHash) { throw 'Candidate changed: use a new receipt directory.' }
    if (($state.packHashes | ConvertTo-Json -Compress) -ne $packJson) { throw 'Verification pack changed: use a new receipt directory.' }
    if ($state.signOff) { throw 'Receipt already signed off: use a new receipt directory for another run.' }
} else {
    $state = [pscustomobject]@{
        schemaVersion = 1; runId = [guid]::NewGuid().ToString(); candidateSha256 = $candidateHash
        builds = $config; packHashes = $packHashes; artifacts = @()
        createdAt = [DateTime]::UtcNow.ToString('o'); windows = $null; history = @(); signOff = $null
        retainedFixtureManifest = $null; retainedInventory = @(); uninstallRetainedInventory = @()
        verdict = 'incomplete'; runtimeError = $null
        checks = @($CheckPlan | ForEach-Object {
            [pscustomobject]@{ id = $_.Id; phase = $_.Phase; result = 'not yet run'; logPaths = @(); evidence = @(); observedAt = $null }
        })
    }
}
$runDirectory = Join-Path $OutputDirectory ([guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $runDirectory
$script:activeCheck = $null

function Save-Receipt {
    $results = @($state.checks | ForEach-Object { $_.result })
    $recordedFailures = @($state.history | Where-Object { $_.result -eq 'fail' })
    $state.verdict = if ($results -contains 'fail' -or $recordedFailures.Count -or $state.runtimeError) { 'fail' }
        elseif ($results -contains 'not yet run') { 'incomplete' }
        elseif ($state.signOff) { 'pass' } else { 'awaiting sign-off' }
    $temporary = Join-Path $runDirectory ([guid]::NewGuid().ToString('N') + '.json')
    Write-JsonFile -Path $temporary -Value $state
    if (Test-Path -LiteralPath $receiptPath) {
        [IO.File]::Replace($temporary, $receiptPath, (Join-Path $runDirectory ([guid]::NewGuid().ToString('N') + '.previous.json')))
    } else { Move-Item -LiteralPath $temporary -Destination $receiptPath }
}

function Invoke-Check([string]$Id, [scriptblock]$Action) {
    $check = @($state.checks | Where-Object { $_.id -eq $Id -and $_.phase -eq $Phase })
    if ($check.Count -ne 1) { throw "Unknown check $Id for $Phase" }
    $check = $check[0]
    $script:activeCheck = $check
    $log = Join-Path $runDirectory ($Id + '.' + [guid]::NewGuid().ToString('N') + '.log')
    $result = 'pass'
    try { & $Action | Out-String | Set-Content -LiteralPath $log -Encoding UTF8 }
    catch { $result = 'fail'; $_.Exception.Message | Set-Content -LiteralPath $log -Encoding UTF8 }
    # A diagnostic retry may succeed, but it cannot repair this qualification run.
    if ($check.result -ne 'fail') { $check.result = $result }
    $check.observedAt = [DateTime]::UtcNow.ToString('o')
    $check.logPaths = @($check.logPaths) + $log
    $state.history = @($state.history) + [pscustomobject]@{ id = $Id; phase = $Phase; result = $result; logPath = $log; at = $check.observedAt }
    $script:activeCheck = $null
    Save-Receipt
    Write-Output "$Phase $Id attempt=$result qualification=$($check.result) : $log"
}

function Get-RetainedInventory($Files) {
    if (@($Files).Count -eq 0) { throw 'Retained fixture inventory must not be empty.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $Files) {
        if (-not [IO.Path]::IsPathRooted($file.path) -or $file.comparison -notin @('sha256','exists')) { throw 'Retained files require absolute paths and sha256/exists comparison.' }
        $path = [IO.Path]::GetFullPath($file.path)
        if (-not $seen.Add($path)) { throw "Duplicate retained file: $path" }
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing retained file: $path" }
        $hash = if ($file.comparison -eq 'sha256') { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
        [pscustomobject]@{ path = $path; comparison = $file.comparison; sha256 = $hash }
    }
}

function Assert-RetainedInventory($Inventory) {
    if (@($Inventory).Count -eq 0) { throw 'No pre-uninstall retained inventory was recorded.' }
    foreach ($file in $Inventory) {
        if (-not (Test-Path -LiteralPath $file.path -PathType Leaf)) { throw "Missing retained file after uninstall: $($file.path)" }
        if ($file.comparison -eq 'sha256') {
            if ((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Retained file changed after uninstall: $($file.path)" }
        } elseif ($file.comparison -ne 'exists') { throw 'Unknown retained-file comparison.' }
    }
    Write-Output "Verified $(@($Inventory).Count) retained files after uninstall."
}

function Get-CandidatePackage {
    $packages = @(Get-AppxPackage -Name $config.packageName | Where-Object { $_.Name -eq $config.packageName })
    if ($packages.Count -ne 1) { throw 'Expected exactly one installed candidate package for the current user.' }
    return $packages[0]
}

function Assert-Artifact($Build) {
    $hash = (Get-FileHash -LiteralPath $Build.artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $Build.sha256) { throw 'MSIX SHA256 does not match the reviewed candidate.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Build.artifact
    if ($signature.Status -ne 'Valid') { throw "MSIX signature is $($signature.Status); do not import a test root or disable protection." }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Build.artifact)
    try {
        $entry = $archive.GetEntry('AppxManifest.xml')
        if (-not $entry) { throw 'MSIX is missing AppxManifest.xml.' }
        $reader = [IO.StreamReader]::new($entry.Open())
        try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $archive.Dispose() }
    $packageIdentity = $manifest.Package.Identity
    if ($packageIdentity.Name -ne $config.packageName -or $packageIdentity.Version -ne $Build.version -or $packageIdentity.ProcessorArchitecture -ne 'x64') { throw 'Signed MSIX identity/version/architecture differs from the x64 candidate.' }
    if (@($state.artifacts | Where-Object { $_.publisher -ne $packageIdentity.Publisher }).Count) { throw 'Candidate and upgrade must use the same publisher identity.' }
    $state.artifacts = @($state.artifacts) + [pscustomobject]@{ commit = $Build.commit; sha256 = $hash
        path = $Build.artifact; signature = [string]$signature.Status; signerThumbprint = $signature.SignerCertificate.Thumbprint
        publisher = $packageIdentity.Publisher; architecture = $packageIdentity.ProcessorArchitecture
        packageName = $packageIdentity.Name; version = $packageIdentity.Version; observedAt = [DateTime]::UtcNow.ToString('o') }
    Write-Output "MSIX sha256=$hash signer=$($signature.SignerCertificate.Thumbprint) sourceCommit=$($Build.commit) (source binding requires WIN-20)"
}

function Assert-Payload($Build) {
    $package = Get-CandidatePackage
    if ([string]$package.Version -ne $Build.version) { throw 'Installed package version differs from candidate.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Build.artifact)
    $count = 0
    try {
        foreach ($entry in $archive.Entries) {
            $entryName = $entry.FullName.Replace('\', '/')
            if ($entryName -notmatch '^(app/|faravan-tray\.exe$|faravan\.exe$|faravan\.cmd$|faravan\.cmd$)' -or $entryName.EndsWith('/')) { continue }
            $target = [IO.Path]::GetFullPath((Join-Path $package.InstallLocation $entryName))
            if (-not $target.StartsWith($package.InstallLocation.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'MSIX payload path escapes package.' }
            $stream = $entry.Open()
            $algorithm = [Security.Cryptography.SHA256]::Create()
            try { $expected = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
            finally { $stream.Dispose(); $algorithm.Dispose() }
            $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
            if ($expected -ne $actual) { throw "Installed payload mismatch: $($entry.FullName)" }
            $count++
        }
    } finally { $archive.Dispose() }
    if ($count -lt 5) { throw 'MSIX has no complete Faravan payload.' }
    Write-Output "Verified $count installed payload files; package=$($package.PackageFullName)"
}

function Invoke-Utf8Process([string]$Executable, [string[]]$Arguments, [string]$StdoutPath, [string]$StderrPath) {
    # These arguments contain paths only. Reject quotes rather than implement a second command-line parser.
    if (($Arguments -join '') -match '"') { throw 'Double quotes are not valid in verification paths.' }
    $quoted = @($Arguments | ForEach-Object { '"' + $_.TrimEnd('\') + '"' })
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = $quoted -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = $utf8
    $startInfo.StandardErrorEncoding = $utf8
    $processChild = [Diagnostics.Process]::new()
    $processChild.StartInfo = $startInfo
    $stdoutTask = $null; $stderrTask = $null
    try {
        $null = $processChild.Start()
        $stdoutTask = $processChild.StandardOutput.ReadToEndAsync()
        $stderrTask = $processChild.StandardError.ReadToEndAsync()
        if (-not $processChild.WaitForExit(100000)) {
            & taskkill.exe /PID $processChild.Id /T /F | Out-Null
            throw 'Native probe timed out; its process tree was stopped.'
        }
        if (-not $stdoutTask.Wait(5000) -or -not $stderrTask.Wait(5000)) { throw 'Native output streams did not close.' }
        if ($processChild.ExitCode -ne 0) { throw "Native probe failed; see $StdoutPath and $StderrPath" }
        $stdoutTask.GetAwaiter().GetResult()
    } finally {
        $outputText = if ($stdoutTask -and $stdoutTask.Status -eq 'RanToCompletion') { $stdoutTask.GetAwaiter().GetResult() } else { 'stdout did not complete' }
        $errorText = if ($stderrTask -and $stderrTask.Status -eq 'RanToCompletion') { $stderrTask.GetAwaiter().GetResult() } else { 'stderr did not complete' }
        [IO.File]::WriteAllText($StdoutPath, $outputText, $utf8)
        [IO.File]::WriteAllText($StderrPath, $errorText, $utf8)
        $processChild.Dispose()
    }
}

function Invoke-Native([string]$Action) {
    $package = Get-CandidatePackage
    $runtime = Join-Path $package.InstallLocation 'app\runtime\node.exe'
    $scratch = Join-Path $runDirectory $Action
    $stdout = Join-Path $runDirectory ($Action + '.stdout.log')
    $stderr = Join-Path $runDirectory ($Action + '.stderr.log')
    $arguments = @((Join-Path $PSScriptRoot 'native-probes.mjs'), $Action, (Join-Path $package.InstallLocation 'app'), $scratch)
    if ($script:activeCheck) { $script:activeCheck.logPaths = @($script:activeCheck.logPaths) + @($stdout, $stderr) }
    Invoke-Utf8Process -Executable $runtime -Arguments $arguments -StdoutPath $stdout -StderrPath $stderr
}

function Get-Snapshot {
    $snapshot = Invoke-Native 'ready' | ConvertFrom-Json
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($snapshot.pid)"
    $root = (Get-CandidatePackage).InstallLocation.TrimEnd('\') + '\'
    if (-not $processInfo.ExecutablePath -or -not $processInfo.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Discovery PID is not from this installed package.' }
    $snapshot | Add-Member -NotePropertyName processStartedAt -NotePropertyValue ($processInfo.CreationDate.ToUniversalTime().ToString('o'))
    $snapshot | Add-Member -NotePropertyName boot -NotePropertyValue $state.windows.boot
    return $snapshot
}

function Invoke-ManualSignOff([string]$EvidencePath, [string]$Signer) {
    if ([string]::IsNullOrWhiteSpace($Signer) -or -not $EvidencePath) { throw 'SignOff requires -Operator and -ManualEvidence.' }
    $manual = Read-JsonFile $EvidencePath
    if ($manual.runId -ne $state.runId -or $manual.candidateSha256 -ne $candidateHash) { throw 'Manual evidence belongs to another run/build.' }
    # Validate the complete import before changing any receipt check.
    foreach ($observation in $manual.observations) {
        $target = @($state.checks | Where-Object { $_.id -eq $observation.id -and $_.phase -eq 'Review' })
        if ($target.Count -ne 1 -or $observation.result -notin @('pass','fail','not yet run')) { throw 'Unknown manual check or result.' }
        if (@($manual.observations | Where-Object { $_.id -eq $observation.id }).Count -ne 1) { throw 'Duplicate manual observation.' }
        if ($observation.result -ne 'not yet run') {
            $timestamp = [DateTimeOffset]::MinValue
            if (-not $observation.notes -or -not [DateTimeOffset]::TryParse($observation.observedAt, [ref]$timestamp) -or @($observation.evidence).Count -eq 0) { throw 'Observed manual checks need notes, timestamp and evidence file paths.' }
        }
        foreach ($path in $observation.evidence) {
            if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Evidence must be an existing absolute file path.' }
        }
    }
    foreach ($observation in $manual.observations) {
        $target = @($state.checks | Where-Object { $_.id -eq $observation.id -and $_.phase -eq 'Review' })[0]
        $target.evidence = @($observation.evidence | ForEach-Object {
            [pscustomobject]@{ path = $_; sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() }
        })
        if ($target.result -ne 'fail') { $target.result = $observation.result }
        $target.observedAt = $observation.observedAt
        $log = Join-Path $runDirectory ($observation.id + '.' + [guid]::NewGuid().ToString('N') + '.manual.json')
        Write-JsonFile -Path $log -Value $observation
        $target.logPaths = @($log)
        $state.history = @($state.history) + [pscustomobject]@{ id = $observation.id; phase = 'Review'; result = $observation.result; logPath = $log; at = $observation.observedAt }
    }
    foreach ($check in $state.checks) {
        $check.evidence = @($check.evidence) + @($check.logPaths | ForEach-Object {
            [pscustomobject]@{ path = $_; sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() }
        })
    }
    $state.signOff = [pscustomobject]@{ operator = $Signer; at = [DateTime]::UtcNow.ToString('o')
        statement = 'I reviewed this exact candidate receipt and the listed native evidence. Unrun checks remain not yet run.'
        kind = 'operator attestation; no cryptographic identity signature' }
}

try {
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Native Windows checks: not yet run. This host is not Windows.' }
    $os = Get-CimInstance Win32_OperatingSystem
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $developerKey = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -ErrorAction SilentlyContinue
    $developerMode = $developerKey -and $developerKey.PSObject.Properties['AllowDevelopmentWithoutDevLicense'] -and $developerKey.AllowDevelopmentWithoutDevLicense -eq 1
    if ($state.windows -and ($state.windows.userSid -ne $identity.User.Value -or $state.windows.build -ne $os.BuildNumber)) { throw 'Windows user/build changed: use a new receipt directory.' }
    $state.windows = [pscustomobject]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber
        boot = $os.LastBootUpTime.ToUniversalTime().ToString('o'); architecture = $os.OSArchitecture
        userSid = $identity.User.Value; profile = $env:USERPROFILE; powershell = $PSVersionTable.PSVersion.ToString(); developerMode = [bool]$developerMode }
    if ([int]$os.BuildNumber -lt 22000 -or $os.ProductType -ne 1 -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $developerMode -or
        $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use Windows 11, Developer Mode off, from a non-elevated standard-user terminal.' }
    if ($Phase -eq 'Baseline') {
        Invoke-Check 'WIN-01' {
            if (@(Get-AppxPackage -Name $config.packageName).Count) { throw 'Baseline requires no previous Faravan package.' }
            foreach ($name in @('FARAVAN_HOME','FARAVAN_HOME','FARAVAN_COORDINATOR_HOME','FARAVAN_COORDINATOR_HOME','FARAVAN_SBX_BIN')) {
                if ([Environment]::GetEnvironmentVariable($name)) { throw "Baseline must not override $name" }
            }
            foreach ($path in @('.faravan','.faravan','.faravan-preview','.waspflow\faravan')) {
                if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE $path)) { throw "Baseline has existing state: $path" }
            }
            $state.windows | ConvertTo-Json
        }
        Invoke-Check 'WIN-02' { Assert-Artifact $config.build; Assert-Artifact $config.upgrade }
    } elseif ($Phase -eq 'Install') {
        Invoke-Check 'WIN-03' {
            foreach ($id in @('WIN-01','WIN-02')) {
                if (@($state.checks | Where-Object { $_.id -eq $id -and $_.result -eq 'pass' }).Count -ne 1) { throw 'Pass Baseline before installing.' }
            }
            Assert-Artifact $config.build
            Add-AppxPackage -Path $config.build.artifact -ErrorAction Stop
            Assert-Payload $config.build
        }
    } elseif ($Phase -eq 'Inspect') {
        Assert-Artifact $config.build
        Assert-Payload $config.build | Out-Null
        $fixtureDeclarationPath = $RetainedFixtures
        Invoke-Check 'WIN-04' {
            if (-not $fixtureDeclarationPath) { throw 'Inspect requires -RetainedFixtures with the predeclared fixture JSON.' }
            $manifestHash = (Get-FileHash -LiteralPath $fixtureDeclarationPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($state.retainedFixtureManifest -and $state.retainedFixtureManifest.sha256 -ne $manifestHash) { throw 'Retained fixture declaration changed within this run.' }
            $snapshot = Get-Snapshot
            $manifest = Read-JsonFile $fixtureDeclarationPath
            if (@($manifest.files).Count -eq 0) { throw 'Declare at least one retained fixture beyond the core state files.' }
            foreach ($file in $manifest.files) {
                $fullPath = [IO.Path]::GetFullPath($file.path)
                $roots = @($snapshot.dataHome, $snapshot.coordinatorHome)
                if (-not @($roots | Where-Object { $fullPath.StartsWith($_.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) }).Count) { throw 'Retained fixtures must be inside the actual data/coordinator homes.' }
            }
            $core = @('device.pem','state.json','app-settings.json') | ForEach-Object {
                [pscustomobject]@{ path = Join-Path (Join-Path $snapshot.dataHome 'v1') $_; comparison = 'sha256' }
            }
            $state.retainedInventory = @(Get-RetainedInventory -Files (@($core) + @($manifest.files)))
            $state.retainedFixtureManifest = [pscustomobject]@{ path = [IO.Path]::GetFullPath($fixtureDeclarationPath); sha256 = $manifestHash }
            Write-JsonFile -Path (Join-Path $OutputDirectory 'before.json') -Value $snapshot
            'Authenticated installed app is ready; recovery baseline and retained fixture inventory saved.'
        }
        Invoke-Check 'WIN-06' {
            $alias = Get-Command faravan.exe -CommandType Application -ErrorAction Stop
            $expected = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\faravan.exe'
            if ($alias.Source -ne $expected) { throw 'faravan.exe resolved outside the Windows App Execution Alias directory.' }
            $manifest = Get-AppxPackageManifest -Package (Get-CandidatePackage).PackageFullName
            if ($manifest.OuterXml -notmatch 'Alias="faravan.exe"') { throw 'Candidate does not register faravan.exe.' }
            Invoke-Native 'cli'
        }
        Invoke-Check 'WIN-07' { Invoke-Native 'lock' }
        Invoke-Check 'WIN-08' { Invoke-Native 'ownership' }
        Invoke-Check 'WIN-13' { if ($env:USERPROFILE -notmatch '[^\x00-\x7F]') { throw 'Use a real non-ASCII Windows profile; a redirected test HOME does not qualify.' }; $env:USERPROFILE }
        Invoke-Check 'WIN-14' {
            $documents = [Environment]::GetFolderPath('MyDocuments')
            $roots = @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial) | Where-Object { $_ }
            if (-not @($roots | Where-Object { $documents.StartsWith($_.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) }).Count) { throw 'Documents is not redirected into OneDrive.' }
            "Known-folder Documents=$documents"
        }
        Invoke-Check 'WIN-16' {
            $snapshot = Invoke-Native 'state' | ConvertFrom-Json
            foreach ($relative in @('', 'v1', 'v1\device.pem', 'v1\state.json', 'v1\app-settings.json')) {
                $path = if ($relative) { Join-Path $snapshot.dataHome $relative } else { $snapshot.dataHome }
                $acl = Get-Acl -LiteralPath $path
                [pscustomobject]@{ path = $path; owner = $acl.Owner; sddl = $acl.Sddl } | ConvertTo-Json -Compress
            }
            'DACL collection only. Effective access by a second user requires WIN-16 Review.'
        }
        Invoke-Check 'WIN-18' { Invoke-Native 'filesystem' }
    } elseif ($Phase -in @('AfterCrash','AfterReboot')) {
        $id = if ($Phase -eq 'AfterCrash') { 'WIN-09' } else { 'WIN-10' }
        Invoke-Check $id {
            Assert-Artifact $config.build; Assert-Payload $config.build
            $before = Read-JsonFile (Join-Path $OutputDirectory 'before.json')
            $after = Get-Snapshot
            if ($Phase -eq 'AfterCrash' -and ($before.boot -ne $after.boot -or $before.processStartedAt -eq $after.processStartedAt)) { throw 'Kill/relaunch was not observed in the same boot.' }
            if ($Phase -eq 'AfterReboot' -and $before.boot -eq $after.boot) { throw 'No reboot observed since Inspect.' }
            if ($before.deviceKeySha256 -ne $after.deviceKeySha256 -or $before.stateSha256 -ne $after.stateSha256) { throw 'Device identity or circle state changed during recovery.' }
            $after | ConvertTo-Json
        }
    } elseif ($Phase -eq 'Upgrade') {
        Invoke-Check 'WIN-11' {
            Assert-Artifact $config.upgrade
            Assert-Payload $config.build
            $before = Invoke-Native 'state' | ConvertFrom-Json
            $root = (Get-CandidatePackage).InstallLocation.TrimEnd('\') + '\'
            if (@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) }).Count) { throw 'Quit the app/tray before Upgrade; no forced shutdown is performed.' }
            if ([version]$config.upgrade.version -le [version]$config.build.version) { throw 'Upgrade must have a strictly newer package version.' }
            Add-AppxPackage -Path $config.upgrade.artifact -ErrorAction Stop
            Assert-Payload $config.upgrade
            # A person reopens the app and verifies results/history in WIN-11 Review.
            Write-JsonFile -Path (Join-Path $OutputDirectory 'pre-upgrade.json') -Value $before
            'Upgrade installed; human state/relaunch check is still required.'
        }
    } elseif ($Phase -eq 'Uninstall') {
        Invoke-Check 'WIN-12' {
            Assert-Payload $config.upgrade
            $snapshot = Get-Snapshot
            $old = Read-JsonFile (Join-Path $OutputDirectory 'pre-upgrade.json')
            if ($snapshot.deviceKeySha256 -ne $old.deviceKeySha256 -or $snapshot.stateSha256 -ne $old.stateSha256) { throw 'Upgrade changed identity/circle state.' }
            $package = Get-CandidatePackage
            $state.uninstallRetainedInventory = @(Get-RetainedInventory -Files $state.retainedInventory)
            Save-Receipt
            Invoke-Native 'uninstall'
            Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop
            # Use saved absolute paths only; the app and runtime have now been removed.
            Assert-RetainedInventory -Inventory $state.uninstallRetainedInventory
            if (@(Get-AppxPackage -Name $config.packageName).Count) { throw 'Package remains registered.' }
            foreach ($key in @('HKCU:\Software\Classes\faravan','HKCU:\Software\Classes\faravan','HKCU:\Software\Classes\AppUserModelId\Faravan.Desktop')) {
                if (Test-Path $key) { throw "Leftover registration: $key" }
            }
            foreach ($entry in @(@('Run','Faravan'), @('RunOnce','FaravanSetup'))) {
                $key = Get-ItemProperty ('HKCU:\Software\Microsoft\Windows\CurrentVersion\' + $entry[0]) -ErrorAction SilentlyContinue
                if ($key -and $key.PSObject.Properties[$entry[1]]) { throw 'Leftover startup registry value.' }
            }
            $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Faravan.lnk'
            if (Test-Path -LiteralPath $startup) { throw 'Startup shortcut remains.' }
            $running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($package.InstallLocation.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) })
            if ($running.Count) { throw 'Installed processes remain after uninstall.' }
            if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\faravan.exe')) { throw 'CLI alias remains after uninstall.' }
            "Expected retained data: $($snapshot.dataHome); receipt/artifacts retained: $OutputDirectory"
        }
    } elseif ($Phase -eq 'SignOff') {
        Invoke-ManualSignOff -EvidencePath $ManualEvidence -Signer $Operator
    }
} catch {
    $state.runtimeError = $_.Exception.Message
    Write-Warning $state.runtimeError
} finally {
    Save-Receipt
    $template = [pscustomobject]@{ runId = $state.runId; candidateSha256 = $candidateHash
        observations = @($state.checks | Where-Object { $_.phase -eq 'Review' } | ForEach-Object {
            [pscustomobject]@{ id = $_.id; result = 'not yet run'; observedAt = ''; notes = ''; evidence = @() }
        }) }
    Write-JsonFile -Path (Join-Path $runDirectory 'manual-template.json') -Value $template
    (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant() | Set-Content (Join-Path $OutputDirectory 'receipt.sha256') -Encoding ASCII
    Write-Output "Receipt: $receiptPath; verdict: $($state.verdict)"
}
} finally {
    $receiptLock.Dispose()
}
if ($state.verdict -eq 'pass') { exit 0 }
if ($state.verdict -eq 'fail') { exit 1 }
exit 2
